import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { ErpIngestionEmailWithServices, ErpIngestionService } from '../lib/types'

/** Autocares Julia — "ERP Quote Ingestion - Barcelona". */
export const ERP_INGESTION_AUTOMATION_ID = 21

const PAGE_SIZE = 50

type Props = {
  automationId: number
  lang: 'EN' | 'ES'
}

const COPY = {
  EN: {
    head: 'Quote requests',
    search: 'Search subject…',
    received: 'Received',
    contact: 'Contact',
    services: (n: number) => `${n} ${n === 1 ? 'service' : 'services'}`,
    route: 'Route',
    pax: 'Passengers',
    departure: 'Departure',
    arrival: 'Arrival',
    itinerary: 'Itinerary',
    noServices: 'No services parsed',
    empty: 'No quote requests yet',
    noMatch: 'No requests match that subject',
    seeMore: 'See more',
    loading: 'Loading…',
  },
  ES: {
    head: 'Solicitudes de presupuesto',
    search: 'Buscar asunto…',
    received: 'Recibido',
    contact: 'Contacto',
    services: (n: number) => `${n} ${n === 1 ? 'servicio' : 'servicios'}`,
    route: 'Trayecto',
    pax: 'Pasajeros',
    departure: 'Salida',
    arrival: 'Llegada',
    itinerary: 'Itinerario',
    noServices: 'Sin servicios detectados',
    empty: 'Aún no hay solicitudes',
    noMatch: 'Ninguna solicitud coincide con ese asunto',
    seeMore: 'Ver más',
    loading: 'Cargando…',
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

export function ErpIngestionTable({ automationId, lang }: Props) {
  const t = COPY[lang]
  const locale = lang === 'ES' ? 'es-ES' : 'en-GB'

  const [rows, setRows] = useState<ErpIngestionEmailWithServices[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [errored, setErrored] = useState(false)
  // Bumped on every search change so a stale in-flight fetch can't overwrite fresh results.
  const reqId = useRef(0)

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
        .select('id, created_at, automation_id, email_id, email_subject, contact_name, contact_email, contact_phone')
        .eq('automation_id', automationId)
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1)
      const term = search.trim()
      if (term) q = q.ilike('email_subject', `%${term}%`)

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

  return (
    <div className="detail-strip erp-strip">
      <div className="strip-head">
        <span>{t.head}</span>
        <input
          className="erp-search"
          type="text"
          value={query}
          placeholder={t.search}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
      </div>

      <div className="erp-body">
        {rows.map((email) => (
          <div className="erp-email" key={email.id}>
            <div className="erp-email-head">
              <span className="erp-subject">{email.email_subject || '—'}</span>
              <span className="erp-date">{fmtDateTime(email.created_at, locale)}</span>
            </div>
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
              <span className="erp-svc-count">{t.services(email.services.length)}</span>
            </div>

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
                      <td className="erp-itin" title={s.itinerary || undefined}>
                        {s.itinerary || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="erp-no-services">{t.noServices}</div>
            )}
          </div>
        ))}

        {loading && <div className="erp-loading">{t.loading}</div>}
        {!loading && rows.length === 0 && (
          <div className="erp-empty">{query.trim() ? t.noMatch : errored ? '—' : t.empty}</div>
        )}
      </div>

      {hasMore && (
        <div className="erp-more">
          <button type="button" disabled={loading} onClick={() => void fetchPage(query, rows.length)}>
            {t.seeMore}
          </button>
        </div>
      )}
    </div>
  )
}
