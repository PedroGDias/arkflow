import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { env } from '../lib/env'
import { supabase } from '../lib/supabase'
import type { Automation, Run } from '../lib/types'
import { COST_ASSUMPTIONS, fmtTime, rel } from '../lib/roiMath'
import { TEAM_MEMBERS } from '../lib/team'

type AutoWithRuns = Automation & { runs: Run[] }

// ── Helpers ────────────────────────────────────────────────────────────────
function chevronSvg() {
  return (
    <svg
      className="chevron"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  )
}

function fmtDurationS(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '–'
  if (seconds >= 24 * 60 * 60) {
    const totalHours = Math.round(seconds / 3600)
    const d = Math.floor(totalHours / 24)
    const h = totalHours % 24
    return h > 0 ? `${d}d ${h}h` : `${d}d`
  }
  if (seconds < 60) return `${Math.round(seconds)}s`
  return fmtTime(seconds / 60)
}

function statusLower(a: Pick<Automation, 'status'>) {
  return (a.status ?? 'Live').toString().trim().toLowerCase()
}

function readMetricNumber(row: unknown, keys: string[]) {
  if (row == null || typeof row !== 'object') return null
  const rec = row as Record<string, unknown>
  for (const k of keys) {
    const v = rec[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.length) {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
  }
  return null
}

// ── Component ──────────────────────────────────────────────────────────────
export function DashboardPage() {
  const { signOut } = useAuth()
  const { clientId: clientIdParam } = useParams<{ clientId: string }>()
  const navigate = useNavigate()
  const cid = Number(clientIdParam) || env.clientId

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [autos, setAutos] = useState<Automation[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [threadTotalsAll, setThreadTotalsAll] = useState<{ total: number | null; completed: number | null }>({ total: null, completed: null })
  const [threadTotalsByAuto, setThreadTotalsByAuto] = useState<Record<number, { total: number; completed: number }> | null>(null)
  const [threadDayCountsByAuto, setThreadDayCountsByAuto] = useState<Record<number, Record<string, number>> | null>(null)

  const coerceFiniteNumber = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.length) {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
    return null
  }

  const manualOverallAvgRespS = useMemo(() => {
    const rows = autos
      .map((a) => ({
        n: coerceFiniteNumber(a.manual_sample_size) ?? 0,
        avg: coerceFiniteNumber(a.manual_avg_response_time),
      }))
      .filter((r) => r.n > 0 && r.avg != null)
    const denom = rows.reduce((s, r) => s + r.n, 0)
    if (denom <= 0) return null
    const numer = rows.reduce((s, r) => s + r.n * (r.avg ?? 0), 0)
    return numer / denom
  }, [autos])

  const [lang, setLang] = useState<'EN' | 'ES'>('EN')

  // accordion: open skill rows (inner level)
  const [openIds, setOpenIds] = useState<Set<number>>(() => new Set())
  // accordion: open team members (outer level) — Carla open by default
  const [openTeamIds, setOpenTeamIds] = useState<Set<string>>(() => new Set(['carla']))
  const [howOpen, setHowOpen] = useState(false)
  const [auditOpen, setAuditOpen] = useState(true)

  const rowEls = useRef(new Map<number, HTMLDivElement>())
  const prevOpenIds = useRef<Set<number>>(new Set())

  // ── i18n ────────────────────────────────────────────────────────────────
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
        finishedHow: 'Threads with status "completed" divided by total threads.',
        yourTeam: 'Your Team',
        members: 'members',
        skills: 'Skills',
        active: 'active',
        noSkills: 'No skills assigned yet',
        activeStatus: 'Active',
        testingStatus: 'Testing',
        inactiveStatus: 'Inactive',
        signOut: 'Sign out',
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
        allClients: '← All clients',
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
        finishedHow: 'Hilos con estado "completed" dividido por el total de hilos.',
        yourTeam: 'Tu equipo',
        members: 'miembros',
        skills: 'Skills',
        active: 'activas',
        noSkills: 'Sin skills asignadas aún',
        activeStatus: 'Activa',
        testingStatus: 'En pruebas',
        inactiveStatus: 'Inactiva',
        signOut: 'Cerrar sesión',
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
        allClients: '← Todos los clientes',
      },
    } as const
    return dict[lang]
  }, [lang])

  function relLang(iso: string) {
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
    const candidates = [a.automation_name_en, a.automation_name_local, a.automation_name_es, a.automation_name]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase())
      .join(' ')
    return candidates.includes('quote') || candidates.includes('presupuesto')
  }

  // ── Data loading ─────────────────────────────────────────────────────────
  async function load() {
    setError(null)
    try {
      if (!supabase) {
        setAutos([])
        setRuns([])
        setThreadTotalsAll({ total: null, completed: null })
        setThreadTotalsByAuto(null)
        setThreadDayCountsByAuto(null)
        setError('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
        return
      }
      const sb = supabase
      const [aRes, rRes] = await Promise.all([
        sb
          .from('automations')
          .select('*,manual_sample_size,manual_avg_response_time')
          .eq('client_id', cid),
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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    const interval = window.setInterval(() => void load(), 30000)
    return () => window.clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid])

  useEffect(() => {
    const prev = prevOpenIds.current
    const newlyOpened = Array.from(openIds).filter((id) => !prev.has(id))
    prevOpenIds.current = new Set(openIds)
    if (newlyOpened.length === 0) return
    const targetId = newlyOpened[newlyOpened.length - 1]
    const el = rowEls.current.get(targetId)
    if (!el) return
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [openIds])

  // ── Derived data ─────────────────────────────────────────────────────────
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
    const avgRespS = totalRuns > 0 ? runs.reduce((s, r) => s + (r.response_time ?? 0), 0) / totalRuns : 0
    const timeSavedMins = totalRuns * COST_ASSUMPTIONS.MANUAL_MINS_PER_RUN
    const speedPct = avgRespS > 0 ? ((COST_ASSUMPTIONS.MANUAL_RESPONSE_S - avgRespS) / COST_ASSUMPTIONS.MANUAL_RESPONSE_S) * 100 : 0
    return { avgRespS, timeSavedMins, speedPct }
  }, [runs, totalRuns])

  // Assign automations to team members; remainder goes to "unassigned"
  const assignedIds = new Set(TEAM_MEMBERS.flatMap((m) => m.automationIds))
  const discoveryAutos = useMemo(() => {
    const rows = autos.filter((a) => statusLower(a) === 'discovery')
    return rows.sort((a, b) => displayAutomationName(a).localeCompare(displayAutomationName(b), undefined, { sensitivity: 'base' }))
  }, [autos, lang])
  const discoveryIds = useMemo(() => new Set(discoveryAutos.map((a) => a.id)), [discoveryAutos])
  const unassignedAutos = Object.values(byAuto).filter((a) => !assignedIds.has(a.id) && !discoveryIds.has(a.id) && statusLower(a) !== 'discovery')
  const missingAssignedIds = useMemo(() => {
    if (loading) return []
    const present = new Set(autos.map((a) => a.id))
    return Array.from(assignedIds).filter((id) => !present.has(id)).sort((a, b) => a - b)
  }, [assignedIds, autos, loading])

  // ── Skill row renderer ────────────────────────────────────────────────────
  function renderSkillRow(a: AutoWithRuns) {
    const r = a.runs
    const avgT = r.length > 0 ? (r.reduce((s, x) => s + (x.response_time ?? 0), 0) / r.length).toFixed(0) : '–'
    const last = r.length > 0 ? relLang(r[0].created_at) : '–'
    const showThreadStats = isQuoteAutomation(a)
    const statusRaw = (a.status ?? 'Live').toString()
    const statusLower = statusRaw.toLowerCase()
    const isLive = statusLower === 'live'
    const isTesting = statusLower === 'testing'
    const statusLabel = isLive ? t.activeStatus : isTesting ? t.testingStatus : t.inactiveStatus
    const statusClass = isLive ? 'live' : isTesting ? 'testing' : 'offline'
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
    const wdLabels = lang === 'ES' ? ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    const maxWd = Math.max(...wdOrder.map((d) => wdCounts[d]), 1)

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
      const [yy, mm, dd] = k.split('-').map((v) => Number(v))
      const d = new Date(yy, (mm ?? 1) - 1, dd ?? 1, 12, 0, 0)
      const locale = lang === 'ES' ? 'es-ES' : 'en-GB'
      return d.toLocaleDateString(locale, { day: '2-digit', month: 'short' })
    })

    const days: Record<string, { total: number; timeSum: number }> = {}
    for (const x of r) {
      const d = new Date(x.created_at)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      days[key] ??= { total: 0, timeSum: 0 }
      days[key].total++
      days[key].timeSum += x.response_time ?? 0
    }

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
    const manualSample = coerceFiniteNumber(a.manual_sample_size)
    const manualAvg = coerceFiniteNumber(a.manual_avg_response_time)

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
              <span className="val">{totalThreadsAuto != null && totalThreadsAuto > 0 ? `${finishedPctAuto.toFixed(0)}%` : '–'}</span>
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
          {/* Manual baseline — compact callout, visually distinct from automation metrics */}
          <div className="benchmark-callout">
            <span className="benchmark-callout-label">
              {lang === 'ES' ? 'Benchmark manual' : 'Manual benchmark'}
            </span>
            <span className="benchmark-callout-vals">
              <span className="benchmark-callout-val">
                {manualSample != null ? manualSample : '–'}
              </span>
              {' '}{lang === 'ES' ? 'msgs' : 'msgs'}{' '}
              <span className="benchmark-callout-note">
                ({lang === 'ES' ? 'muestra' : 'sample'})
              </span>
              {' '}
              <span className="benchmark-callout-sep">·</span>{' '}
              {lang === 'ES' ? 'media ' : 'avg '}
              <span className="benchmark-callout-val">
                {manualAvg != null ? fmtDurationS(manualAvg) : '–'}
              </span>
            </span>
          </div>

          {/* Volume */}
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
                          <div className={`mini-bar ${!showThreadStats || cnt === 0 ? 'zero' : ''}`} style={{ height: `${pct}%` }}></div>
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

          {/* Performance */}
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
  }

  function renderAuditRow(a: Automation) {
    const manualSample = coerceFiniteNumber(a.manual_sample_size)
    const manualAvg = coerceFiniteNumber(a.manual_avg_response_time)

    // Manual performance metrics (columns live on `automations`, names may vary)
    const totalThreads =
      readMetricNumber(a, ['manual_threads', 'manual_total_threads', 'manual_total_conversations', 'manual_nr_conversations', 'manual_nr_threads']) ??
      readMetricNumber(a, ['nr_conversations', 'nr_threads', 'total_threads', 'total_conversations'])
    const completedThreads =
      readMetricNumber(a, ['manual_completed', 'manual_completed_threads', 'manual_completed_conversations', 'completed_threads', 'completed_conversations']) ??
      readMetricNumber(a, ['completed'])
    const hangingThreads =
      readMetricNumber(a, ['manual_hanging', 'manual_hanging_threads', 'manual_hanging_conversations', 'hanging_threads', 'hanging_conversations']) ??
      readMetricNumber(a, ['hanging'])
    const avgTimeToCompleteS = readMetricNumber(a, [
      'manual_avg_time_to_complete_s',
      'manual_avg_time_to_complete',
      'manual_avg_time_to_complete_seconds',
      'avg_time_to_complete_s',
      'avg_time_to_complete',
      'avg_time_to_complete_seconds',
    ])

    const completionPct =
      totalThreads != null && totalThreads > 0 && completedThreads != null ? (completedThreads / totalThreads) * 100 : null
    const hangingPct =
      totalThreads != null && totalThreads > 0 && hangingThreads != null ? (hangingThreads / totalThreads) * 100 : null

    const st = statusLower(a)
    const isDiscovery = st === 'discovery'
    const statusLabel = isDiscovery ? (lang === 'ES' ? 'Discovery' : 'Discovery') : (a.status ?? '—').toString()
    const statusClass = isDiscovery ? 'discovery' : 'offline'

    return (
      <div key={a.id} className="auto-row" data-auto-id={a.id}>
        <div className="auto-summary audit-summary" style={{ cursor: 'default' }}>
          <div className="auto-name">
            {displayAutomationName(a)}
            <span className={`row-live ${statusClass}`}>
              <span className={`live-dot ${statusClass}`}></span>
              {statusLabel}
            </span>
          </div>

          <div className="auto-stat audit-stat">
            <small>{lang === 'ES' ? 'Muestra (msgs)' : 'Sample (msgs)'}</small>
            <span className="val">{manualSample != null ? manualSample : '–'}</span>
          </div>
          <div className="auto-stat audit-stat hl">
            <small>{lang === 'ES' ? 'Resp. media (manual)' : 'Avg resp (manual)'}</small>
            <span className="val">{manualAvg != null ? fmtDurationS(manualAvg) : '–'}</span>
          </div>
          <div className="auto-stat audit-stat">
            <small>{lang === 'ES' ? 'Hilos' : 'Threads'}</small>
            <span className="val">{totalThreads != null ? Math.round(totalThreads) : '–'}</span>
          </div>
          <div className="auto-stat audit-stat good">
            <small>{lang === 'ES' ? 'Completadas' : 'Completed'}</small>
            <span className="val">
              {completionPct != null ? `${completionPct.toFixed(0)}%` : '–'}
            </span>
          </div>
          <div className="auto-stat audit-stat">
            <small>{lang === 'ES' ? 'Hanging' : 'Hanging'}</small>
            <span className="val">{hangingPct != null ? `${hangingPct.toFixed(0)}%` : '–'}</span>
          </div>
          <div className="auto-stat audit-stat hl">
            <small>{lang === 'ES' ? 'Tiempo para cerrar' : 'Avg time to close'}</small>
            <span className="val">{avgTimeToCompleteS != null ? fmtDurationS(avgTimeToCompleteS) : '–'}</span>
          </div>
        </div>
      </div>
    )
  }

  // ── Team member header renderer ───────────────────────────────────────────
  function renderTeamMember(member: (typeof TEAM_MEMBERS)[number]) {
    const memberAutos = (member.automationIds.map((id) => byAuto[id]).filter(Boolean) as AutoWithRuns[]).filter((a) => statusLower(a) !== 'discovery')
    const memberRuns = memberAutos.flatMap((a) => a.runs)
    const totalReplies = memberRuns.length
    const avgRespS = totalReplies > 0 ? memberRuns.reduce((s, r) => s + (r.response_time ?? 0), 0) / totalReplies : 0
    const timeSavedMins = totalReplies * COST_ASSUMPTIONS.MANUAL_MINS_PER_RUN
    const perfPct = avgRespS > 0 ? ((COST_ASSUMPTIONS.MANUAL_RESPONSE_S - avgRespS) / COST_ASSUMPTIONS.MANUAL_RESPONSE_S) * 100 : 0
    const hasLive = memberAutos.some((a) => (a.status ?? 'Live').toString().toLowerCase() === 'live')
    const hasTesting = memberAutos.some((a) => (a.status ?? '').toString().toLowerCase() === 'testing')
    const isOpen = openTeamIds.has(member.id)

    const statusClass = memberAutos.length === 0 ? 'offline' : hasLive ? 'live' : hasTesting ? 'testing' : 'offline'
    const statusLabel =
      memberAutos.length === 0
        ? t.inactiveStatus
        : hasLive
          ? t.activeStatus
          : hasTesting
            ? t.testingStatus
            : t.inactiveStatus

    return (
      <div key={member.id} className={`team-member ${isOpen ? 'open' : ''}`}>
        <div
          className="team-member-header"
          onClick={() =>
            setOpenTeamIds((prev) => {
              const next = new Set(prev)
              if (next.has(member.id)) next.delete(member.id)
              else next.add(member.id)
              return next
            })
          }
        >
          <div
            className="team-member-avatar"
            style={{ background: member.avatarBg, color: member.avatarColor }}
          >
            {member.initials}
          </div>
          <div className="team-member-info">
            <div className="team-member-name">
              {member.name}
              <span className={`row-live ${statusClass}`}>
                <span className={`live-dot ${statusClass}`}></span>
                {statusLabel}
              </span>
            </div>
            <div className="team-member-role">{member.role[lang]}</div>
          </div>

          <div className="team-stat">
            <span className="ts-val">{totalReplies > 0 ? totalReplies : <span className="dim">–</span>}</span>
            <small>{t.msgs}</small>
          </div>
          <div className="team-stat">
            <span className={`ts-val ${totalReplies > 0 && perfPct > 0 ? 'green' : 'dim'}`}>
              {totalReplies > 0 ? `${perfPct.toFixed(0)}%` : '–'}
            </span>
            <small>{t.perf}</small>
          </div>
          <div className="team-stat">
            <span className="ts-val">{avgRespS > 0 ? `${avgRespS.toFixed(0)}s` : <span className="dim">–</span>}</span>
            <small>{t.avg}</small>
          </div>
          <div className="team-stat">
            <span className={`ts-val ${totalReplies > 0 ? 'green' : 'dim'}`}>
              {totalReplies > 0 ? fmtTime(timeSavedMins) : '–'}
            </span>
            <small>{t.saved}</small>
          </div>

          {chevronSvg()}
        </div>

        <div className="team-member-body">
          <div className="team-member-skills">
            {loading ? (
              <div className="skills-empty">
                <div className="spinner" style={{ margin: '0 auto 8px' }}></div>
              </div>
            ) : memberAutos.length > 0 ? (
              <div className="auto-list">
                {memberAutos.map((a) => renderSkillRow(a))}
              </div>
            ) : (
              <div className="skills-empty">{t.noSkills}</div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="page">
      <header className="header">
        <div className="wrap">
          <a className="logo" href="#">
            <img src="/logos/arkflow-logo.svg" alt="Arkflow" className="logo-img" />
          </a>
          <div className="header-r">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  display: 'inline-flex',
                  border: '1px solid var(--border)',
                  borderRadius: 999,
                  overflow: 'hidden',
                }}
              >
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
                {t.signOut}
              </button>
            </div>
          </div>
        </div>
      </header>

      <section className="topbar">
        <div className="wrap">
          <button className="back-link" onClick={() => navigate('/')}>
            {t.allClients}
          </button>
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
                  ({t.vsManual} {manualOverallAvgRespS != null ? fmtDurationS(manualOverallAvgRespS) : '–'})
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

          <button className={`how-btn ${howOpen ? 'open' : ''}`} onClick={() => setHowOpen((v) => !v)}>
            {t.howCalculated}
          </button>
          <div className={`how-panel ${howOpen ? 'open' : ''}`}>
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
          {error ? (
            <div className="error-msg">Failed to load. {error}</div>
          ) : !loading && autos.length === 0 && runs.length === 0 ? (
            <div className="error-msg" style={{ background: 'var(--red-bg)', color: 'var(--red)' }}>
              No rows are visible from Supabase. This usually means Row Level Security is enabled without a SELECT policy for the current access mode (anon).
            </div>
          ) : (
            <div className="team-list">
              {!loading && missingAssignedIds.length > 0 && (
                <div className="error-msg" style={{ background: 'var(--red-bg)', color: 'var(--red)' }}>
                  Missing automations in DB for this client: {missingAssignedIds.join(', ')}. Check you’re pointing at the expected Supabase project and RLS allows selecting `automations`.
                </div>
              )}

              {/* Audit — opportunities for automation (Discovery) */}
              {!loading && discoveryAutos.length > 0 && (
                <div className={`team-member audit-member ${auditOpen ? 'open' : ''}`}>
                  <div className="team-member-header" onClick={() => setAuditOpen((v) => !v)}>
                    <div
                      className="team-member-avatar"
                      style={{ background: 'var(--card)', color: 'var(--text3)' }}
                    >
                      A
                    </div>
                    <div className="team-member-info">
                      <div className="team-member-name" style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text3)' }}>
                        {lang === 'ES' ? 'Auditoría - Oportunidades de automatización' : 'Audit - Opportunities for Automation'}
                      </div>
                      <div className="team-member-role">
                        {lang === 'ES'
                          ? 'Automatizaciones en discovery (candidatas) · basado en 5 semanas de datos'
                          : 'Automations in discovery (candidates) · based on 5 weeks of data'}
                      </div>
                    </div>
                    <div className="team-stat">
                      <span className="ts-val">{discoveryAutos.length}</span>
                      <small>{lang === 'ES' ? 'Oportunidades' : 'Opportunities'}</small>
                    </div>
                    {chevronSvg()}
                  </div>
                  <div className="team-member-body">
                    <div className="team-member-skills">
                      <div className="auto-list">
                        {discoveryAutos.map((a) => renderAuditRow(a))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="section-head">
                <div className="section-label">{t.yourTeam}</div>
                <div className="section-count">
                  {TEAM_MEMBERS.length} {t.members}
                </div>
              </div>

              {TEAM_MEMBERS.map((member) => renderTeamMember(member))}
              {/* Unassigned automations catch-all */}
              {!loading && unassignedAutos.length > 0 && (
                <div className="team-member open">
                  <div className="team-member-header" style={{ cursor: 'default' }}>
                    <div
                      className="team-member-avatar"
                      style={{ background: 'var(--card)', color: 'var(--text3)' }}
                    >
                      –
                    </div>
                    <div className="team-member-info">
                      <div className="team-member-name" style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text3)' }}>
                        {lang === 'EN' ? 'Unassigned' : 'Sin asignar'}
                      </div>
                    </div>
                  </div>
                  <div className="team-member-body">
                    <div className="team-member-skills">
                      <div className="auto-list">
                        {unassignedAutos.map((a) => renderSkillRow(a))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      <footer className="footer">
        <div className="wrap">
          <a href="#">Arkflow</a> · {lang === 'EN' ? 'AI workers that do the work' : 'IA que trabaja por ti'}
        </div>
      </footer>
    </div>
  )
}
