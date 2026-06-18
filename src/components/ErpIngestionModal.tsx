import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from '../lib/supabase'
import type { ErpIngestionEmailWithServices, ErpIngestionService } from '../lib/types'

/** Autocares Julia — "ERP Quote Ingestion - Barcelona". */
export const ERP_INGESTION_AUTOMATION_ID = 21

const PAGE_SIZE = 50

type Props = {
  automationId: number
  lang: 'EN' | 'ES'
  title: string
  onClose: () => void
}

const COPY = {
  EN: {
    requests: 'quote requests',
    search: 'Search subject, contact, message…',
    services: (n: number) => `${n} ${n === 1 ? 'service' : 'services'}`,
    route: 'Route',
    pax: 'Passengers',
    departure: 'Departure',
    arrival: 'Arrival',
    itinerary: 'Itinerary',
    services_h: 'Extracted services',
    original: 'Original message',
    noServices: 'No services parsed',
    empty: 'No quote requests yet',
    noMatch: 'No requests match that subject',
    seeMore: 'See more',
    loading: 'Loading…',
    close: 'Close',
  },
  ES: {
    requests: 'solicitudes de presupuesto',
    search: 'Buscar asunto, contacto, mensaje…',
    services: (n: number) => `${n} ${n === 1 ? 'servicio' : 'servicios'}`,
    route: 'Trayecto',
    pax: 'Pasajeros',
    departure: 'Salida',
    arrival: 'Llegada',
    itinerary: 'Itinerario',
    services_h: 'Servicios extraídos',
    original: 'Mensaje original',
    noServices: 'Sin servicios detectados',
    empty: 'Aún no hay solicitudes',
    noMatch: 'Ninguna solicitud coincide con ese asunto',
    seeMore: 'Ver más',
    loading: 'Cargando…',
    close: 'Cerrar',
  },
} as const

function fmtDateTime(s: string | null, locale: string) {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleString(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function ErpIngestionModal({ automationId, lang, title, onClose }: Props) {
  const t = COPY[lang]
  const locale = lang === 'ES' ? 'es-ES' : 'en-GB'

  const [rows, setRows] = useState<ErpIngestionEmailWithServices[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [errored, setErrored] = useState(false)
  const [openIds, setOpenIds] = useState<Set<number>>(() => new Set())
  // Bumped on every search change so a stale in-flight fetch can't overwrite fresh results.
  const reqId = useRef(0)

  const toggle = (id: number) =>
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const fetchPage = useCallback(
    async (search: string, offset: number) => {
      const sb = supabase
      if (!sb) {
        setErrored(true)
        setLoading(false)
        return
      }
      const myReq = ++reqId.current
      setLoading(true)

      let q = sb
        .from('erp_ingestion_emails')
        .select('id, created_at, automation_id, email_id, email_subject, contact_name, contact_email, contact_phone, source_message')
        .eq('automation_id', automationId)
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1)
      // Match across subject, contact, and the original message body. Strip
      // commas/parens so the user's text can't break PostgREST's or() syntax.
      const term = search.trim().replace(/[,()]/g, ' ').trim()
      if (term) {
        const like = `%${term}%`
        q = q.or(
          [
            `email_subject.ilike.${like}`,
            `contact_name.ilike.${like}`,
            `contact_email.ilike.${like}`,
            `source_message.ilike.${like}`,
          ].join(','),
        )
      }

      const { data: emails, error } = await q
      if (myReq !== reqId.current) return // a newer search superseded this one
      if (error || !emails) {
        setErrored(true)
        setLoading(false)
        return
      }

      const ids = emails.map((e) => e.id)
      let services: ErpIngestionService[] = []
      if (ids.length) {
        const { data: svc } = await sb
          .from('erp_ingestion_services')
          .select('*')
          .in('email_row_id', ids)
          .order('departure_datetime', { ascending: true, nullsFirst: false })
        if (myReq !== reqId.current) return
        services = svc ?? []
      }

      const page: ErpIngestionEmailWithServices[] = emails.map((e) => ({
        ...e,
        services: services.filter((s) => s.email_row_id === e.id),
      }))

      setErrored(false)
      setHasMore(emails.length === PAGE_SIZE)
      setRows((prev) => (offset === 0 ? page : [...prev, ...page]))
      setLoading(false)
    },
    [automationId],
  )

  // Initial load + debounced reload whenever the search term changes.
  useEffect(() => {
    const handle = setTimeout(() => void fetchPage(query, 0), query ? 300 : 0)
    return () => clearTimeout(handle)
  }, [query, fetchPage])

  // Escape to close + lock background scroll while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  return createPortal(
    <div className="erp-modal-overlay" onClick={onClose}>
      <div className="erp-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="erp-modal-head">
          <div className="erp-modal-title">
            {title}
            <span className="erp-modal-sub">
              {rows.length}
              {hasMore ? '+' : ''} {t.requests}
            </span>
          </div>
          <input
            className="erp-search"
            type="text"
            value={query}
            placeholder={t.search}
            autoFocus
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
          <button type="button" className="erp-modal-close" aria-label={t.close} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="erp-modal-body">
          {rows.map((email) => {
            const open = openIds.has(email.id)
            return (
            <div className={`erp-email ${open ? 'open' : ''}`} key={email.id}>
              <button type="button" className="erp-email-summary" onClick={() => toggle(email.id)}>
                <div className="erp-sum-main">
                  <span className="erp-subject">{email.email_subject || '—'}</span>
                  <div className="erp-contact">
                    {email.contact_name && <span className="erp-contact-item">{email.contact_name}</span>}
                    {email.contact_email && (
                      <span className="erp-contact-item">
                        <span className="lbl">@</span>
                        {email.contact_email}
                      </span>
                    )}
                    {email.contact_phone && (
                      <span className="erp-contact-item">
                        <span className="lbl">tel</span>
                        {email.contact_phone}
                      </span>
                    )}
                  </div>
                </div>
                <span className="erp-svc-count">{t.services(email.services.length)}</span>
                <span className="erp-date">{fmtDateTime(email.created_at, locale)}</span>
                <svg className="erp-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </button>

              {open && (
              <div className="erp-email-grid">
                <div className="erp-col-services">
                  <div className="erp-col-head">{t.services_h}</div>
                  {email.services.length > 0 ? (
                    <table className="erp-services">
                      <thead>
                        <tr>
                          <th>{t.route}</th>
                          <th>{t.pax}</th>
                          <th>{t.departure}</th>
                          <th>{t.arrival}</th>
                          <th>{t.itinerary}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {email.services.map((s) => (
                          <tr key={s.id}>
                            <td className="erp-route">
                              {s.origin || '—'}
                              <span className="arr">→</span>
                              {s.destination || '—'}
                            </td>
                            <td className="erp-pax">{s.passengers || '—'}</td>
                            <td className="erp-dt">{fmtDateTime(s.departure_datetime, locale)}</td>
                            <td className="erp-dt">{fmtDateTime(s.arrival_datetime, locale)}</td>
                            <td className="erp-itin">{s.itinerary || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="erp-no-services">{t.noServices}</div>
                  )}
                </div>

                <div className="erp-col-source">
                  <div className="erp-col-head">{t.original}</div>
                  <pre className="erp-source">{email.source_message || '—'}</pre>
                </div>
              </div>
              )}
            </div>
            )
          })}

          {loading && <div className="erp-loading">{t.loading}</div>}
          {!loading && rows.length === 0 && (
            <div className="erp-empty">{query.trim() ? t.noMatch : errored ? '—' : t.empty}</div>
          )}

          {hasMore && (
            <div className="erp-more">
              <button type="button" disabled={loading} onClick={() => void fetchPage(query, rows.length)}>
                {t.seeMore}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
