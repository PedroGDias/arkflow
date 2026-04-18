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

export function DashboardPage() {
  const { signOut } = useAuth()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [autos, setAutos] = useState<Automation[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [threadTotals, setThreadTotals] = useState<{ total: number | null; completed: number | null }>({ total: null, completed: null })
  const [threadDayCounts, setThreadDayCounts] = useState<Record<string, number> | null>(null)

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
        vsManual5m: 'vs MANUAL 1h34m',
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
        vsManual5m: 'vs MANUAL 1h34m',
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
        setThreadTotals({ total: null, completed: null })
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
        const since = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
        const [totRes, doneRes, dayRes] = await Promise.all([
          sb.from('julia_thread_stats_prod').select('*', { count: 'exact', head: true }),
          sb.from('julia_thread_stats_prod').select('*', { count: 'exact', head: true }).eq('status', 'completed'),
          sb.from('julia_thread_stats_prod').select('created_at').gte('created_at', since).order('created_at', { ascending: true }).limit(20000),
        ])

        if (totRes.error || doneRes.error) {
          setThreadTotals({ total: null, completed: null })
        } else {
          setThreadTotals({
            total: totRes.count ?? 0,
            completed: doneRes.count ?? 0,
          })
        }

        if (dayRes.error) {
          setThreadDayCounts(null)
        } else {
          const m: Record<string, number> = {}
          for (const row of dayRes.data ?? []) {
            // created_at is assumed to be ISO timestamps; bucket by local day.
            const d = new Date((row as { created_at: string }).created_at)
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
            m[key] = (m[key] ?? 0) + 1
          }
          setThreadDayCounts(m)
        }
      } catch {
        setThreadTotals({ total: null, completed: null })
        setThreadDayCounts(null)
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
  const totalThreads = threadTotals.total
  const completedThreads = threadTotals.completed
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
                {t.avgResponseTime} <span style={{ color: 'var(--text4)' }}>({t.vsManual5m})</span>
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
                const customersByDayL10D = last10DayKeys.map((k) => (threadDayCounts?.[k] ?? 0))
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
                        <span className="row-live">
                          <span className="live-dot"></span>Live
                        </span>
                      </div>
                      <div className="auto-stat">
                        <small>{t.msgs}</small>
                        <span className="val">{r.length}</span>
                      </div>
                      {showThreadStats ? (
                        <div className="auto-stat">
                          <small>{t.totalConversations}</small>
                          <span className="val">{totalThreads != null ? totalThreads : '–'}</span>
                        </div>
                      ) : null}
                      {showThreadStats ? (
                        <div className="auto-stat good">
                          <small>{t.completed}</small>
                          <span className="val">
                            {totalThreads != null && totalThreads > 0 ? `${finishedPct.toFixed(0)}%` : '–'}
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
                                    <div className={`mini-bar ${cnt === 0 ? 'zero' : ''}`} style={{ height: `${Math.max(pct, cnt > 0 ? 6 : 0)}%` }}></div>
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
                                    <div
                                      className={`mini-bar ${!showThreadStats || cnt === 0 ? 'zero' : ''}`}
                                      style={{ height: `${Math.max(pct, showThreadStats && cnt > 0 ? 6 : 0)}%` }}
                                    ></div>
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
                                    <div className={`hour-bar ${cnt === 0 ? 'zero' : ''}`} style={{ height: `${Math.max(pct, cnt > 0 ? 6 : 0)}%` }}></div>
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
                                    <div className={`mini-bar ${cnt === 0 ? 'zero' : ''}`} style={{ height: `${Math.max(pct, cnt > 0 ? 6 : 0)}%` }}></div>
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
                                    <div className={`mini-bar ${avg === 0 ? 'zero' : ''}`} style={{ height: `${Math.max(pct, avg > 0 ? 6 : 0)}%` }}></div>
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
                                    <div className={`mini-bar ${mins === 0 ? 'zero' : ''}`} style={{ height: `${Math.max(pct, mins > 0 ? 6 : 0)}%` }}></div>
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
                                    <div className={`mini-bar ${avg === 0 ? 'zero' : ''}`} style={{ height: `${Math.max(pct, avg > 0 ? 6 : 0)}%` }}></div>
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
        <div className="wrap">Powered by <a href="#">Arkflow</a> · We automate your manual work.</div>
      </footer>
    </div>
  )
}

