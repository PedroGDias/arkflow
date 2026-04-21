import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { env } from '../lib/env'
import { supabase } from '../lib/supabase'
import type { Automation, Run } from '../lib/types'
import { COST_ASSUMPTIONS, fmtTime, rel } from '../lib/roiMath'

type AutoWithRuns = Automation & { runs: Run[] }

function chevronSvg() {
  return (
    <svg className="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 6l4 4 4-4" />
    </svg>
  )
}

function fmtDurationS(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '–'
  if (seconds < 60) return `${Math.round(seconds)}s`
  return fmtTime(seconds / 60)
}

export function DashboardPage() {
  const { signOut } = useAuth()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [autos, setAutos] = useState<Automation[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [threadTotalsAll, setThreadTotalsAll] = useState<{ total: number | null; completed: number | null }>({ total: null, completed: null })
  const [threadTotalsByAuto, setThreadTotalsByAuto] = useState<Record<number, { total: number; completed: number }> | null>(null)
  const [threadDayCountsByAuto, setThreadDayCountsByAuto] = useState<Record<number, Record<string, number>> | null>(null)
  const [manualAuditByAuto, setManualAuditByAuto] = useState<
    Record<string, { conversations: number; totalMsgs: number; avgRespS: number | null }> | null
  >(null)
  const [manualAuditOverallAvgRespS, setManualAuditOverallAvgRespS] = useState<number | null>(null)

  const [lang, setLang] = useState<'EN' | 'ES'>('EN')

  const [openIds, setOpenIds] = useState<Set<number>>(() => new Set())
  const [howOpen, setHowOpen] = useState(false)

  const rowEls = useRef(new Map<number, HTMLDivElement>())
  const prevOpenIds = useRef<Set<number>>(new Set())

  const t = useMemo(() => {
    const dict = {
      EN: {
        clientDashboard: 'Client Dashboard',
        howCalculated: 'How are these calculated?',
        avgResponseTime: 'Avg Response Time',
        vsManual: 'vs MANUAL',
        timeSaved: '⏱ Time Saved',
        timeSavedHow: 'Total staff time recovered based on the agreed manual handling time per request (5 min), multiplied by total replies processed.',
        avgRespHow: "Average response time of the automation's messages in production, compared to a 5 minute manual baseline.",
        totalConversations: 'Customers',
        pctFinished: '% Finished',
        finishedHow: 'Threads with status “completed” divided by total threads.',
        automations: 'Automations',
        active: 'active',
        volume: 'Volume',
        totalMsgs: 'Total Replies',
        repliesL10D: 'Replies / Day (L10D)',
        customersL10D: 'Customers / Day (L10D)',
        byHour: 'By Hour of Day',
        respTimeByHour: 'Avg Response Time by Hour (s)',
        byWeekday: 'By Weekday',
        performance: 'Performance',
        perfImprovement: 'Performance Improvement',
        avgRespByDay: 'Avg Response Time by Day (s)',
        savedTimeL10D: 'Saved Time / Day (L10D)',
        msgs: 'Replies',
        avg: 'Avg',
        saved: '⏱ Saved',
        perf: 'Perf',
        lastMsg: 'Last Reply',
        justNow: 'just now',
        quoteRequest: 'Quote Request',
        completed: 'Completed',
      },
      ES: {
        clientDashboard: 'Panel de Cliente',
        howCalculated: '¿Cómo se calcula?',
        avgResponseTime: 'Tiempo medio de respuesta',
        vsManual: 'vs MANUAL',
        timeSaved: '⏱ Tiempo ahorrado',
        timeSavedHow:
          'Tiempo total recuperado según el tiempo manual acordado por solicitud (5 min), multiplicado por el total de respuestas procesadas.',
        avgRespHow: 'Tiempo medio de respuesta de los mensajes en producción, comparado con una línea base manual de 5 minutos.',
        totalConversations: 'Clientes',
        pctFinished: '% finalizadas',
        finishedHow: 'Hilos con estado “completed” dividido por el total de hilos.',
        automations: 'Automatizaciones',
        active: 'activas',
        volume: 'Volumen',
        totalMsgs: 'Respuestas totales',
        repliesL10D: 'Respuestas / día (L10D)',
        customersL10D: 'Clientes / día (L10D)',
        byHour: 'Por hora del día',
        respTimeByHour: 'Tiempo medio por hora (s)',
        byWeekday: 'Por día de la semana',
        performance: 'Rendimiento',
        perfImprovement: 'Mejora de rendimiento',
        avgRespByDay: 'Tiempo medio por día (s)',
        savedTimeL10D: 'Tiempo ahorrado / día (L10D)',
        msgs: 'Respuestas',
        avg: 'Media',
        saved: '⏱ Ahorrado',
        perf: 'Rend.',
        lastMsg: 'Última respuesta',
        justNow: 'ahora mismo',
        quoteRequest: 'Solicitud de Presupuesto',
        completed: 'Completadas',
      },
    } as const
    return dict[lang]
  }, [lang])

  function relLang(iso: string) {
    // keep the existing relative formatter for EN, lightweight ES override
    if (lang === 'EN') return rel(iso)
    const s = (Date.now() - new Date(iso).getTime()) / 1000
    if (s < 60) return t.justNow
    if (s < 3600) return `hace ${Math.round(s / 60)}m`
    if (s < 86400) return `hace ${Math.round(s / 3600)}h`
    return `hace ${Math.round(s / 86400)}d`
  }

  function displayAutomationName(a: Automation) {
    const en = a.automation_name_en ?? a.automation_name ?? ''
    const local = a.automation_name_local ?? a.automation_name_es ?? a.automation_name ?? ''
    const chosen = lang === 'ES' ? local : en
    return chosen || a.automation_name || '—'
  }

  function isQuoteAutomation(a: Automation) {
    const candidates = [
      a.automation_name_en,
      a.automation_name_local,
      a.automation_name_es,
      a.automation_name,
    ]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase())
      .join(' ')
    return candidates.includes('quote') || candidates.includes('presupuesto')
  }

  async function load() {
    setError(null)
    try {
      if (!supabase) {
        setAutos([])
        setRuns([])
        setThreadTotalsAll({ total: null, completed: null })
        setThreadTotalsByAuto(null)
        setThreadDayCountsByAuto(null)
        setManualAuditByAuto(null)
        setManualAuditOverallAvgRespS(null)
        setError('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
        return
      }
      const sb = supabase
      const cid = env.clientId
      const [aRes, rRes] = await Promise.all([
        sb.from('automations').select('*').eq('client_id', cid),
        sb
          .from('runs')
          .select('*,automations!inner(client_id)')
          .eq('automations.client_id', cid)
          .order('created_at', { ascending: false })
          .limit(10000),
      ])

      if (aRes.error) throw aRes.error
      if (rRes.error) throw rRes.error

      setAutos((aRes.data ?? []) as Automation[])
      setRuns((rRes.data ?? []) as unknown as Run[])

      // Thread-level conversation stats (pending/completed).
      // Assumption: 1 row in julia_thread_stats_prod == 1 thread.
      // Optional: don't block dashboard if table/policy isn't ready.
      try {
        const sinceIso = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
        const batchSize = 5000
        const maxRows = 100000
        const autoIds = ((aRes.data ?? []) as Automation[]).map((a) => a.id)

        const rows: Array<{ automation_id: number; status: string | null; created_at: string }> = []
        if (autoIds.length === 0) {
          setThreadTotalsAll({ total: 0, completed: 0 })
          setThreadTotalsByAuto({})
          setThreadDayCountsByAuto({})
          return
        }
        for (let offset = 0; offset < maxRows; offset += batchSize) {
          const res = await sb
            .from('julia_thread_stats_prod')
            .select('automation_id,status,created_at')
            .in('automation_id', autoIds)
            .order('created_at', { ascending: false })
            .range(offset, offset + batchSize - 1)

          if (res.error) throw res.error

          const batch = (res.data ?? []) as unknown as Array<{ automation_id: number; status: string | null; created_at: string }>
          rows.push(...batch)
          if (batch.length < batchSize) break
        }

        const totalsByAuto: Record<number, { total: number; completed: number }> = {}
        const dayCountsByAuto: Record<number, Record<string, number>> = {}

        let totalAll = 0
        let completedAll = 0

        for (const row of rows) {
          totalAll++
          if (row.status === 'completed') completedAll++

          const aid = row.automation_id
          totalsByAuto[aid] ??= { total: 0, completed: 0 }
          totalsByAuto[aid].total++
          if (row.status === 'completed') totalsByAuto[aid].completed++

          if (row.created_at >= sinceIso) {
            const d = new Date(row.created_at)
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
            dayCountsByAuto[aid] ??= {}
            dayCountsByAuto[aid][key] = (dayCountsByAuto[aid][key] ?? 0) + 1
          }
        }

        setThreadTotalsAll({ total: totalAll, completed: completedAll })
        setThreadTotalsByAuto(totalsByAuto)
        setThreadDayCountsByAuto(dayCountsByAuto)
      } catch {
        setThreadTotalsAll({ total: null, completed: null })
        setThreadTotalsByAuto(null)
        setThreadDayCountsByAuto(null)
      }

      // Manual baseline (sample) for quote-email threads.
      // Table: audit_julia_quote_emails, 1 row = 1 conversation in the sample.
      // We compute:
      // - conversations: row count
      // - totalMsgs: sum(row.nr_msgs)
      // - avgRespS: weighted average of row response time per message, weighted by nr_msgs
      try {
        const res = await sb.from('audit_julia_quote_emails').select('automation_id,nr_msgs,avg_resp_time').limit(100000)
        if (res.error) throw res.error

        const rows = (res.data ?? []) as Array<Record<string, unknown>>
          const getNumber = (row: Record<string, unknown>, keys: string[]) => {
            for (const k of keys) {
              const v = row[k]
              if (typeof v === 'number' && Number.isFinite(v)) return v
              if (typeof v === 'string') {
                const n = Number(v)
                if (Number.isFinite(n)) return n
              }
            }
            return null
          }

          const msgKeys = ['nr_msgs', 'nr_messages', 'num_msgs', 'msgs', 'msg_count', 'message_count', 'messages', 'total_msgs']
          const respKeys = [
            // preferred explicit seconds
            'response_time_s',
            'avg_response_time_s',
            'response_time_seconds',
            'avg_response_seconds',
            // common generic names
            'response_time',
            'avg_response_time',
            // your audit table column
            'avg_resp_time',
            // "per message" naming variants
            'response_time_per_msg_s',
            'response_time_per_message_s',
            'avg_response_time_per_msg_s',
            'avg_response_time_per_message_s',
            'response_time_per_msg',
            'response_time_per_message',
            'avg_response_time_per_msg',
            'avg_response_time_per_message',
          ]

          const by: Record<string, { conversations: number; totalMsgs: number; respWeightedSum: number; respWeight: number }> = {}
          let overallWeightedSum = 0
          let overallWeight = 0
          for (const row of rows) {
            const aidRaw = row['automation_id']
            const aid =
              typeof aidRaw === 'number' || typeof aidRaw === 'string'
                ? String(aidRaw)
                : null
            if (!aid) continue

            const msgs = getNumber(row, msgKeys) ?? 0
            const resp = getNumber(row, respKeys)

            by[aid] ??= { conversations: 0, totalMsgs: 0, respWeightedSum: 0, respWeight: 0 }
            by[aid].conversations += 1
            by[aid].totalMsgs += msgs

            if (resp != null && msgs > 0) {
              by[aid].respWeightedSum += resp * msgs
              by[aid].respWeight += msgs

              overallWeightedSum += resp * msgs
              overallWeight += msgs
            }
          }

          const out: Record<string, { conversations: number; totalMsgs: number; avgRespS: number | null }> = {}
          for (const [aidStr, v] of Object.entries(by)) {
            const avgRespS = v.respWeight > 0 ? v.respWeightedSum / v.respWeight : null
            out[aidStr] = { conversations: v.conversations, totalMsgs: v.totalMsgs, avgRespS }
          }
          setManualAuditByAuto(out)
          setManualAuditOverallAvgRespS(overallWeight > 0 ? overallWeightedSum / overallWeight : null)
      } catch {
        setManualAuditByAuto(null)
        setManualAuditOverallAvgRespS(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    const t = window.setInterval(() => void load(), 30000)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const prev = prevOpenIds.current
    const newlyOpened = Array.from(openIds).filter((id) => !prev.has(id))
    prevOpenIds.current = new Set(openIds)

    if (newlyOpened.length === 0) return

    const targetId = newlyOpened[newlyOpened.length - 1]
    const el = rowEls.current.get(targetId)
    if (!el) return

    // Wait a frame so the "open" class + height transition are applied,
    // then scroll the row into view.
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [openIds])

  const byAuto: Record<number, AutoWithRuns> = useMemo(() => {
    const m: Record<number, AutoWithRuns> = {}
    for (const a of autos) m[a.id] = { ...(a as Automation), runs: [] }
    for (const r of runs) {
      const bucket = m[r.automation_id]
      if (bucket) bucket.runs.push(r)
    }
    return m
  }, [autos, runs])

  const totalRuns = runs.length
  const totalThreads = threadTotalsAll.total
  const completedThreads = threadTotalsAll.completed
  const finishedPct = totalThreads && totalThreads > 0 && completedThreads != null ? (completedThreads / totalThreads) * 100 : 0
  const kpis = useMemo(() => {
    const avgRespS =
      totalRuns > 0 ? runs.reduce((s, r) => s + (r.response_time ?? 0), 0) / totalRuns : 0

    const timeSavedMins = totalRuns * COST_ASSUMPTIONS.MANUAL_MINS_PER_RUN
    const speedPct = avgRespS > 0 ? ((COST_ASSUMPTIONS.MANUAL_RESPONSE_S - avgRespS) / COST_ASSUMPTIONS.MANUAL_RESPONSE_S) * 100 : 0

    return { avgRespS, timeSavedMins, speedPct }
  }, [runs, totalRuns])

  return (
    <div className="page">
      <header className="header">
        <div className="wrap">
          <a className="logo" href="#">
            <img src="/logos/arkflow-logo.svg" alt="Arkflow" className="logo-img" />
          </a>
          <div className="header-r">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 999, overflow: 'hidden' }}>
                <button
                  onClick={() => setLang('EN')}
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 11,
                    border: 0,
                    background: lang === 'EN' ? 'var(--text)' : 'var(--white)',
                    color: lang === 'EN' ? 'var(--white)' : 'var(--text2)',
                    padding: '6px 10px',
                    cursor: 'pointer',
                  }}
                >
                  EN
                </button>
                <button
                  onClick={() => setLang('ES')}
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 11,
                    border: 0,
                    background: lang === 'ES' ? 'var(--text)' : 'var(--white)',
                    color: lang === 'ES' ? 'var(--white)' : 'var(--text2)',
                    padding: '6px 10px',
                    cursor: 'pointer',
                  }}
                >
                  ES
                </button>
              </div>

            <button
              onClick={() => void signOut()}
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                border: '1px solid var(--border)',
                background: 'var(--white)',
                borderRadius: 999,
                padding: '6px 12px',
                cursor: 'pointer',
              }}
            >
              Sign out
            </button>
            </div>
          </div>
        </div>
      </header>

      <section className="topbar">
        <div className="wrap">
          <div className="topbar-label">{t.clientDashboard}</div>
          <h1>
            <img src="/logos/android-chrome-192x192.png" alt="Autocares Julia" className="client-logo" />
            Autocares Julia
          </h1>

          <div className="kpis">
            <div className="kpi">
              <div className="kpi-val green" id="kAvgResp">
                {kpis.avgRespS > 0 ? `${kpis.avgRespS.toFixed(0)}s` : '–'}
              </div>
              <div className="kpi-lbl">
                {t.avgResponseTime}{' '}
                <span style={{ color: 'var(--text4)' }}>
                  ({t.vsManual} {manualAuditOverallAvgRespS != null ? fmtDurationS(manualAuditOverallAvgRespS) : '–'})
                </span>
              </div>
            </div>
            <div className="kpi">
              <div className="kpi-val green" id="kTimeSaved">
                {fmtTime(kpis.timeSavedMins)}
              </div>
              <div className="kpi-lbl">
                {t.timeSaved} <span style={{ color: 'var(--text4)' }}>({totalRuns} {t.msgs} × 5m)</span>
              </div>
            </div>
            <div className="kpi highlight">
              <div className="kpi-val" id="kTotalConvos">
                {totalThreads != null ? totalThreads : '–'}
              </div>
              <div className="kpi-lbl">{t.totalConversations}</div>
            </div>
            <div className="kpi highlight">
              <div className="kpi-val" id="kFinishedPct">
                {totalThreads != null && totalThreads > 0
                  ? `${finishedPct.toFixed(0)}% (${completedThreads ?? 0}/${totalThreads})`
                  : '–'}
              </div>
              <div className="kpi-lbl">{t.completed}</div>
            </div>
          </div>

          <button className={`how-btn ${howOpen ? 'open' : ''}`} id="howBtn" onClick={() => setHowOpen((v) => !v)}>
            {t.howCalculated}
          </button>
          <div className={`how-panel ${howOpen ? 'open' : ''}`} id="howPanel">
            <div className="how-grid">
              <div className="how-item">
                <div className="how-name">{t.avgResponseTime}</div>
                <div className="how-desc">{t.avgRespHow}</div>
              </div>
              <div className="how-item">
                <div className="how-name">{t.timeSaved}</div>
                <div className="how-desc">{t.timeSavedHow}</div>
              </div>
              <div className="how-item">
                <div className="how-name">{t.pctFinished}</div>
                <div className="how-desc">{t.finishedHow}</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <main className="section">
        <div className="wrap">
          <div className="section-head">
            <div className="section-label">{t.automations}</div>
            <div className="section-count" id="autoCount">
              {autos.length ? `${autos.length} ${t.active}` : ''}
            </div>
          </div>

          {loading ? (
            <div className="loading">
              <div className="spinner"></div>Loading…
            </div>
          ) : error ? (
            <div className="error-msg">Failed to load. {error}</div>
          ) : autos.length === 0 && runs.length === 0 ? (
            <div className="error-msg" style={{ background: 'var(--red-bg)', color: 'var(--red)' }}>
              No rows are visible from Supabase. This usually means Row Level Security is enabled without a `SELECT` policy for the current access mode (anon).
            </div>
          ) : (
            <div className="auto-list">
              {Object.values(byAuto).map((a) => {
                const r = a.runs
                const avgT = r.length > 0 ? (r.reduce((s, x) => s + (x.response_time ?? 0), 0) / r.length).toFixed(0) : '–'
                const last = r.length > 0 ? relLang(r[0].created_at) : '–'
                const showThreadStats = isQuoteAutomation(a)
                const statusRaw = (a.status ?? 'Live').toString()
                const isTesting = statusRaw.toLowerCase() === 'testing'
                const statusLabel = isTesting ? 'Testing' : 'Live'
                const statusClass = isTesting ? 'testing' : 'live'
                const threadForAuto = threadTotalsByAuto?.[a.id]
                const totalThreadsAuto = threadForAuto?.total ?? null
                const completedThreadsAuto = threadForAuto?.completed ?? null
                const finishedPctAuto =
                  totalThreadsAuto != null && totalThreadsAuto > 0 && completedThreadsAuto != null
                    ? (completedThreadsAuto / totalThreadsAuto) * 100
                    : 0

                const avgRespA = r.length > 0 ? r.reduce((s, x) => s + (x.response_time ?? 0), 0) / r.length : 0
                const perfPct = avgRespA > 0 ? ((COST_ASSUMPTIONS.MANUAL_RESPONSE_S - avgRespA) / COST_ASSUMPTIONS.MANUAL_RESPONSE_S) * 100 : 0

                const hourCounts = new Array(24).fill(0)
                for (const x of r) hourCounts[new Date(x.created_at).getHours()]++
                const hourTotal = r.length || 1
                const maxH = Math.max(...hourCounts, 1)

                const wdCounts = new Array(7).fill(0)
                for (const x of r) wdCounts[new Date(x.created_at).getDay()]++
                const wdOrder = [1, 2, 3, 4, 5, 6, 0]
                const wdLabels =
                  lang === 'ES' ? ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
                const maxWd = Math.max(...wdOrder.map((d) => wdCounts[d]), 1)

                const days: Record<string, { total: number; timeSum: number }> = {}
                for (const x of r) {
                  const d = new Date(x.created_at)
                  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                  days[key] ??= { total: 0, timeSum: 0 }
                  days[key].total++
                  days[key].timeSum += x.response_time ?? 0
                }

                const last10DayKeys = (() => {
                  const keys: string[] = []
                  const today = new Date()
                  for (let i = 9; i >= 0; i--) {
                    const d = new Date(today)
                    d.setDate(today.getDate() - i)
                    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
                  }
                  return keys
                })()
                const l10dLabels = last10DayKeys.map((k) => {
                  // Parse YYYY-MM-DD as a local date; use noon to avoid DST edge cases.
                  const [yy, mm, dd] = k.split('-').map((v) => Number(v))
                  const d = new Date(yy, (mm ?? 1) - 1, dd ?? 1, 12, 0, 0)
                  const locale = lang === 'ES' ? 'es-ES' : 'en-GB'
                  return d.toLocaleDateString(locale, { day: '2-digit', month: 'short' })
                })
                const avgRespSByDayL10D = last10DayKeys.map((k) => {
                  const dd = days[k]
                  if (!dd || dd.total === 0) return 0
                  return dd.timeSum / dd.total
                })
                const maxDayAvgL10D = Math.max(...avgRespSByDayL10D, 1)
                const repliesByDayL10D = (() => {
                  const m: Record<string, number> = {}
                  for (const x of r) {
                    const d = new Date(x.created_at)
                    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                    m[key] = (m[key] ?? 0) + 1
                  }
                  return last10DayKeys.map((k) => m[k] ?? 0)
                })()
                const savedMinsByDayL10D = repliesByDayL10D.map((cnt) => cnt * COST_ASSUMPTIONS.MANUAL_MINS_PER_RUN)
                const customersByDayL10D = last10DayKeys.map((k) => (threadDayCountsByAuto?.[a.id]?.[k] ?? 0))
                const maxRepliesL10D = Math.max(...repliesByDayL10D, 1)
                const maxSavedMinsL10D = Math.max(...savedMinsByDayL10D, 1)
                const maxCustomersL10D = Math.max(...customersByDayL10D, 1)

                const hourResp = new Array(24).fill(0).map(() => ({ count: 0, timeSum: 0 }))
                for (const x of r) {
                  const h = new Date(x.created_at).getHours()
                  hourResp[h].count++
                  hourResp[h].timeSum += x.response_time ?? 0
                }
                const hourAvgs = hourResp.map((v) => (v.count > 0 ? v.timeSum / v.count : 0))
                const maxHourAvg = Math.max(...hourAvgs, 1)

                const isOpen = openIds.has(a.id)
                const manual = manualAuditByAuto?.[String(a.id)] ?? null

                return (
                  <div
                    key={a.id}
                    className={`auto-row ${isOpen ? 'open' : ''}`}
                    data-auto-id={a.id}
                    ref={(node) => {
                      if (node) rowEls.current.set(a.id, node)
                      else rowEls.current.delete(a.id)
                    }}
                  >
                    <div
                      className="auto-summary"
                      onClick={() => {
                        setOpenIds((prev) => {
                          const next = new Set(prev)
                          if (next.has(a.id)) next.delete(a.id)
                          else next.add(a.id)
                          return next
                        })
                      }}
                    >
                      <div className="auto-name">
                        {displayAutomationName(a)}
                        <span className={`row-live ${statusClass}`}>
                          <span className={`live-dot ${statusClass}`}></span>
                          {statusLabel}
                        </span>
                      </div>
                      <div className="auto-stat">
                        <small>{t.msgs}</small>
                        <span className="val">{r.length}</span>
                      </div>
                      {showThreadStats ? (
                        <div className="auto-stat">
                          <small>{t.totalConversations}</small>
                          <span className="val">{totalThreadsAuto != null ? totalThreadsAuto : '–'}</span>
                        </div>
                      ) : null}
                      {showThreadStats ? (
                        <div className="auto-stat good">
                          <small>{t.completed}</small>
                          <span className="val">
                            {totalThreadsAuto != null && totalThreadsAuto > 0 ? `${finishedPctAuto.toFixed(0)}%` : '–'}
                          </span>
                        </div>
                      ) : null}
                      <div className="auto-stat hl">
                        <small>{t.avg}</small>
                        <span className="val">{avgT}s</span>
                      </div>
                      <div className="auto-stat good">
                        <small>{t.saved}</small>
                        <span className="val">{fmtTime(r.length * COST_ASSUMPTIONS.MANUAL_MINS_PER_RUN)}</span>
                      </div>
                      <div className="auto-stat good">
                        <small>
                          {t.perf} <span className="arrow">↑</span>
                        </small>
                        <span className="val">{perfPct.toFixed(0)}%</span>
                      </div>
                      <div className="auto-stat">
                        <small>{t.lastMsg}</small>
                        <span className="val">{last}</span>
                      </div>
                      {chevronSvg()}
                    </div>

                    <div className="auto-detail">
                      <div className="detail-strip">
                        <div className="strip-head">{lang === 'ES' ? 'Manual (muestra)' : 'Manual (sample)'}</div>
                        <div className="strip-nums volume-three">
                          <div className="strip-num">
                            <div className="sn-lbl">{lang === 'ES' ? 'Conversaciones' : 'Conversations'}</div>
                            <div className={`sn-val ${manualAuditByAuto === null ? 'dim' : ''}`}>
                              {manual ? manual.conversations : manualAuditByAuto === null ? '–' : '0'}
                            </div>
                          </div>
                          <div className="strip-num">
                            <div className="sn-lbl">{lang === 'ES' ? 'Mensajes totales' : 'Total msgs'}</div>
                            <div className={`sn-val ${manualAuditByAuto === null ? 'dim' : ''}`}>
                              {manual ? manual.totalMsgs : manualAuditByAuto === null ? '–' : '0'}
                            </div>
                          </div>
                          <div className="strip-num">
                            <div className="sn-lbl">{lang === 'ES' ? 'Tiempo medio (pond.)' : 'Avg response (weighted)'}</div>
                            <div className={`sn-val ${manualAuditByAuto === null ? 'dim' : ''}`}>
                              {manual
                                ? manual.avgRespS != null
                                  ? fmtDurationS(manual.avgRespS)
                                  : '–'
                                : manualAuditByAuto === null
                                  ? '–'
                                  : '–'}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="detail-strip">
                        <div className="strip-head">{t.volume}</div>
                        <div className="strip-nums volume-four">
                          <div className="strip-num chart">
                            <div className="sn-lbl">{t.repliesL10D}</div>
                            <div className="mini-bars mini-bars-compact">
                              {repliesByDayL10D.map((cnt, i) => {
                                const pct = (cnt / maxRepliesL10D) * 100
                                return (
                                  <div className="mini-bar-g" key={last10DayKeys[i]}>
                                    <div className="mini-bar-v">{cnt > 0 ? `${cnt}` : ''}</div>
                                    <div className="mini-bar-track">
                                      <div className={`mini-bar ${cnt === 0 ? 'zero' : ''}`} style={{ height: `${pct}%` }}></div>
                                    </div>
                                    <div className="mini-bar-lbl">{l10dLabels[i]}</div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>

                          <div className="strip-num chart">
                            <div className="sn-lbl">{t.customersL10D}</div>
                            <div className="mini-bars mini-bars-compact">
                              {(showThreadStats ? customersByDayL10D : last10DayKeys.map(() => 0)).map((cnt, i) => {
                                const pct = (cnt / maxCustomersL10D) * 100
                                return (
                                  <div className="mini-bar-g" key={last10DayKeys[i]}>
                                    <div className="mini-bar-v">{showThreadStats && cnt > 0 ? `${cnt}` : ''}</div>
                                    <div className="mini-bar-track">
                                      <div
                                        className={`mini-bar ${!showThreadStats || cnt === 0 ? 'zero' : ''}`}
                                        style={{ height: `${pct}%` }}
                                      ></div>
                                    </div>
                                    <div className="mini-bar-lbl">{l10dLabels[i]}</div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>

                          <div className="strip-num chart">
                            <div className="sn-lbl">{t.byHour}</div>
                            <div className="hour-bars hour-bars-compact">
                              {hourCounts.map((cnt, h) => {
                                const pct = (cnt / maxH) * 100
                                const dispPct = Math.round((cnt / hourTotal) * 100)
                                return (
                                  <div className="hour-bar-g" key={h}>
                                    <div className="hour-bar-v">{cnt > 0 ? `${dispPct}%` : ''}</div>
                                    <div className="hour-bar-track">
                                      <div className={`hour-bar ${cnt === 0 ? 'zero' : ''}`} style={{ height: `${pct}%` }}></div>
                                    </div>
                                    <div className="hour-lbl">{`${h}h`}</div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>

                          <div className="strip-num chart">
                            <div className="sn-lbl">{t.byWeekday}</div>
                            <div className="mini-bars mini-bars-compact">
                              {wdOrder.map((di, i) => {
                                const cnt = wdCounts[di]
                                const pct = (cnt / maxWd) * 100
                                const dispPct = Math.round((cnt / hourTotal) * 100)
                                return (
                                  <div className="mini-bar-g" key={di}>
                                    <div className="mini-bar-v">{cnt > 0 ? `${dispPct}%` : ''}</div>
                                    <div className="mini-bar-track">
                                      <div className={`mini-bar ${cnt === 0 ? 'zero' : ''}`} style={{ height: `${pct}%` }}></div>
                                    </div>
                                    <div className="mini-bar-lbl">{wdLabels[i]}</div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="detail-strip">
                        <div className="strip-head">{t.performance}</div>
                        <div className="strip-charts three">
                          <div className="strip-chart">
                            <div className="mini-chart-title">{t.avgRespByDay}</div>
                            <div className="mini-bars">
                              {avgRespSByDayL10D.map((avg, i) => {
                                const pct = (avg / maxDayAvgL10D) * 100
                                return (
                                  <div className="mini-bar-g" key={last10DayKeys[i]}>
                                    <div className="mini-bar-v">{avg > 0 ? `${avg.toFixed(0)}s` : ''}</div>
                                    <div className="mini-bar-track">
                                      <div className={`mini-bar ${avg === 0 ? 'zero' : ''}`} style={{ height: `${pct}%` }}></div>
                                    </div>
                                    <div className="mini-bar-lbl">{l10dLabels[i]}</div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>

                          <div className="strip-chart">
                            <div className="mini-chart-title">{t.savedTimeL10D}</div>
                            <div className="mini-bars">
                              {savedMinsByDayL10D.map((mins, i) => {
                                const pct = (mins / maxSavedMinsL10D) * 100
                                return (
                                  <div className="mini-bar-g" key={last10DayKeys[i]}>
                                    <div className="mini-bar-v">{mins > 0 ? fmtTime(mins) : ''}</div>
                                    <div className="mini-bar-track">
                                      <div className={`mini-bar ${mins === 0 ? 'zero' : ''}`} style={{ height: `${pct}%` }}></div>
                                    </div>
                                    <div className="mini-bar-lbl">{l10dLabels[i]}</div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>

                          <div className="strip-chart">
                            <div className="mini-chart-title">{t.respTimeByHour}</div>
                            <div className="mini-bars">
                              {hourAvgs.map((avg, h) => {
                                const pct = (avg / maxHourAvg) * 100
                                return (
                                  <div className="mini-bar-g" key={h}>
                                    <div className="mini-bar-v">{avg > 0 ? `${avg.toFixed(0)}s` : ''}</div>
                                    <div className="mini-bar-track">
                                      <div className={`mini-bar ${avg === 0 ? 'zero' : ''}`} style={{ height: `${pct}%` }}></div>
                                    </div>
                                    <div className="mini-bar-lbl">{`${h}h`}</div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </main>

      <footer className="footer">
        <div className="wrap"><a href="#">Arkflow</a> · AI workers that do the work</div>
      </footer>
    </div>
  )
}

