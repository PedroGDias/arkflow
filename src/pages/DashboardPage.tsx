import { useEffect, useMemo, useState } from 'react'
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

  const [lang, setLang] = useState<'EN' | 'ES'>('EN')

  const [openIds, setOpenIds] = useState<Set<number>>(() => new Set())
  const [howOpen, setHowOpen] = useState(false)

  const t = useMemo(() => {
    const dict = {
      EN: {
        clientDashboard: 'Client Dashboard',
        howCalculated: 'How are these calculated?',
        avgResponseTime: 'Avg Response Time',
        vsManual5m: 'vs MANUAL 1h34m',
        timeSaved: '⏱ Time Saved',
        timeSavedHow: 'Total staff time recovered based on the agreed manual handling time per request (5 min), multiplied by total msgs processed.',
        avgRespHow: "Average response time of the automation's messages in production, compared to a 5 minute manual baseline.",
        totalConversations: 'Customers',
        pctFinished: '% Finished',
        finishedHow: 'Threads with status “completed” divided by total threads.',
        automations: 'Automations',
        active: 'active',
        volume: 'Volume',
        totalMsgs: 'Total Msgs',
        peakHour: 'Peak Hour',
        peakDay: 'Peak Day',
        byHour: 'By Hour of Day',
        byWeekday: 'By Weekday',
        performance: 'Performance',
        perfImprovement: 'Performance Improvement',
        avgRespByDay: 'Avg Response Time by Day (s)',
        msgs: 'Msgs',
        avg: 'Avg',
        saved: '⏱ Saved',
        perf: 'Perf',
        lastMsg: 'Last Msg',
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
        timeSavedHow: 'Tiempo total recuperado según el tiempo manual acordado por solicitud (5 min), multiplicado por el total de msgs procesados.',
        avgRespHow: 'Tiempo medio de respuesta de los mensajes en producción, comparado con una línea base manual de 5 minutos.',
        totalConversations: 'Clientes',
        pctFinished: '% finalizadas',
        finishedHow: 'Hilos con estado “completed” dividido por el total de hilos.',
        automations: 'Automatizaciones',
        active: 'activas',
        volume: 'Volumen',
        totalMsgs: 'Msgs totales',
        peakHour: 'Hora pico',
        peakDay: 'Día pico',
        byHour: 'Por hora del día',
        byWeekday: 'Por día de la semana',
        performance: 'Rendimiento',
        perfImprovement: 'Mejora de rendimiento',
        avgRespByDay: 'Tiempo medio por día (s)',
        msgs: 'Msgs',
        avg: 'Media',
        saved: '⏱ Ahorrado',
        perf: 'Rend.',
        lastMsg: 'Último msg',
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
    const name = (a.automation_name ?? '').toLowerCase()
    if (name.includes('quote') || name.includes('presupuesto')) return t.quoteRequest
    return a.automation_name
  }

  function isQuoteAutomation(a: Automation) {
    const name = (a.automation_name ?? '').toLowerCase()
    return name.includes('quote') || name.includes('presupuesto')
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
      const cid = env.clientId
      const [aRes, rRes] = await Promise.all([
        supabase.from('automations').select('*').eq('client_id', cid),
        supabase
          .from('runs')
          .select('*,automations!inner(client_id,automation_name)')
          .eq('automations.client_id', cid)
          .order('created_at', { ascending: false })
          .limit(10000),
      ])

      if (aRes.error) throw aRes.error
      if (rRes.error) throw rRes.error

      setAutos((aRes.data ?? []) as Automation[])
      setRuns((rRes.data ?? []) as unknown as Run[])

      // Conversation stats are optional: don't block dashboard if table/policy isn't ready.
      const [totRes, doneRes] = await Promise.all([
        supabase.from('julia_thread_stats').select('*', { count: 'exact', head: true }),
        supabase.from('julia_thread_stats').select('*', { count: 'exact', head: true }).eq('status', 'completed'),
      ])

      if (totRes.error || doneRes.error) {
        setThreadTotals({ total: null, completed: null })
      } else {
        setThreadTotals({
          total: totRes.count ?? 0,
          completed: doneRes.count ?? 0,
        })
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
                {kpis.avgRespS > 0 ? `${kpis.avgRespS.toFixed(1)}s` : '–'}
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
                {totalThreads != null && totalThreads > 0 ? `${finishedPct.toFixed(0)}%` : '–'}
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
                const avgT = r.length > 0 ? (r.reduce((s, x) => s + (x.response_time ?? 0), 0) / r.length).toFixed(1) : '–'
                const last = r.length > 0 ? relLang(r[0].created_at) : '–'
                const showThreadStats = isQuoteAutomation(a)

                const avgRespA = r.length > 0 ? r.reduce((s, x) => s + (x.response_time ?? 0), 0) / r.length : 0
                const perfPct = avgRespA > 0 ? ((COST_ASSUMPTIONS.MANUAL_RESPONSE_S - avgRespA) / COST_ASSUMPTIONS.MANUAL_RESPONSE_S) * 100 : 0

                const hourCounts = new Array(24).fill(0)
                for (const x of r) hourCounts[new Date(x.created_at).getHours()]++
                const hourTotal = r.length || 1
                const maxH = Math.max(...hourCounts, 1)
                const peakH = hourCounts.indexOf(Math.max(...hourCounts, 0))
                const peakHlbl = peakH === 0 ? '12am' : peakH < 12 ? `${peakH}am` : peakH === 12 ? '12pm' : `${peakH - 12}pm`

                const wdCounts = new Array(7).fill(0)
                for (const x of r) wdCounts[new Date(x.created_at).getDay()]++
                const wdOrder = [1, 2, 3, 4, 5, 6, 0]
                const wdLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
                const maxWd = Math.max(...wdOrder.map((d) => wdCounts[d]), 1)
                const peakWdIdx = wdOrder.reduce((best, di, i) => (wdCounts[di] > wdCounts[wdOrder[best]] ? i : best), 0)
                const peakWdLabel = wdLabels[peakWdIdx]

                const days: Record<string, { total: number; timeSum: number }> = {}
                for (const x of r) {
                  const day = new Date(x.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                  days[day] ??= { total: 0, timeSum: 0 }
                  days[day].total++
                  days[day].timeSum += x.response_time ?? 0
                }
                const dayKeys = Object.keys(days).reverse()
                const maxDayAvg = Math.max(...dayKeys.map((d) => days[d].timeSum / days[d].total), 1)

                const isOpen = openIds.has(a.id)

                return (
                  <div key={a.id} className={`auto-row ${isOpen ? 'open' : ''}`} data-auto-id={a.id}>
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
                          <span className="val">{totalThreads != null && totalThreads > 0 ? `${finishedPct.toFixed(0)}%` : '–'}</span>
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
                        <span className="val">{perfPct.toFixed(1)}%</span>
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
                        <div className="strip-nums">
                          <div className="strip-num">
                            <div className="sn-lbl">{t.totalMsgs}</div>
                            <div className="sn-val">{r.length}</div>
                          </div>
                          <div className="strip-num">
                            <div className="sn-lbl">{t.peakHour}</div>
                            <div className="sn-val">{r.length > 0 ? peakHlbl : '–'}</div>
                          </div>
                          <div className="strip-num">
                            <div className="sn-lbl">{t.peakDay}</div>
                            <div className="sn-val">{r.length > 0 ? peakWdLabel : '–'}</div>
                          </div>
                        </div>
                        <div className="strip-charts">
                          <div className="strip-chart">
                            <div className="mini-chart-title">{t.byHour}</div>
                            <div className="hour-bars">
                              {hourCounts.map((cnt, h) => {
                                const pct = (cnt / maxH) * 100
                                const dispPct = Math.round((cnt / hourTotal) * 100)
                                const ampm = h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`
                                const showLbl = h % 3 === 0
                                return (
                                  <div className="hour-bar-g" key={h}>
                                    <div className="hour-bar-v">{cnt > 0 ? `${dispPct}%` : ''}</div>
                                    <div className={`hour-bar ${cnt === 0 ? 'zero' : ''}`} style={{ height: `${Math.max(pct, cnt > 0 ? 6 : 0)}%` }}></div>
                                    <div className="hour-lbl">{showLbl ? ampm : ''}</div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                          <div className="strip-chart">
                            <div className="mini-chart-title">{t.byWeekday}</div>
                            <div className="mini-bars">
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
                        <div className="strip-nums">
                          <div className="strip-num">
                            <div className="sn-lbl">{t.avgResponseTime}</div>
                            <div className="sn-val">{avgRespA > 0 ? `${avgRespA.toFixed(1)}s` : '–'}</div>
                          </div>
                          <div className="strip-num">
                            <div className="sn-lbl">{t.perfImprovement}</div>
                            <div className="sn-val green">{perfPct > 0 ? `${perfPct.toFixed(1)}%` : '–'}</div>
                          </div>
                        </div>
                        <div className="strip-charts" style={{ gridTemplateColumns: '1fr' }}>
                          <div className="strip-chart">
                            <div className="mini-chart-title">{t.avgRespByDay}</div>
                            <div className="mini-bars">
                              {dayKeys.map((d) => {
                                const dd = days[d]
                                const avg = dd.timeSum / dd.total
                                const pct = (avg / maxDayAvg) * 100
                                const label = d.split(' ').slice(0, 2).join(' ')
                                return (
                                  <div className="mini-bar-g" key={d}>
                                    <div className="mini-bar-v">{avg.toFixed(0)}s</div>
                                    <div className="mini-bar" style={{ height: `${Math.max(pct, 6)}%` }}></div>
                                    <div className="mini-bar-lbl">{label}</div>
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

