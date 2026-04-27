import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { env } from '../lib/env'
import { supabase } from '../lib/supabase'
import type { Automation, Client, Run } from '../lib/types'
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
  return (a.status ?? '').toString().trim().toLowerCase()
}

function isDiscoveryAutomation(a: Pick<Automation, 'status'>) {
  const s = statusLower(a)
  // Production can contain variants like "Discovery", "In discovery", etc.
  return s.includes('discovery')
}

function splitTaskCity(name: string) {
  const raw = (name ?? '').trim()
  if (!raw) return { task: '—', city: null as string | null }
  const idx = raw.indexOf(' - ')
  if (idx === -1) return { task: raw, city: null }
  const task = raw.slice(0, idx).trim() || '—'
  const city = raw.slice(idx + 3).trim() || null
  return { task, city }
}

function commonFiniteNumberOrNull(
  rows: Automation[],
  key: keyof Pick<Automation, 'manual_execution_time_min' | 'manual_hourly_cost'>,
) {
  const vals = rows
    .map((a) => a[key])
    .filter((v) => typeof v === 'number' && Number.isFinite(v)) as number[]
  if (vals.length === 0) return null
  const first = vals[0]
  if (vals.every((v) => v === first)) return first
  return null
}

function readMetricIntegerString(row: unknown, keys: string[]) {
  if (row == null || typeof row !== 'object') return null
  const rec = row as Record<string, unknown>
  for (const k of keys) {
    const v = rec[k]
    if (typeof v === 'number' && Number.isFinite(v)) return String(Math.trunc(v))
    if (typeof v === 'string' && v.length) {
      const s = v.trim()
      if (/^-?\d+$/.test(s)) return s
    }
  }
  return null
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

const CURRENCIES = [
  { code: 'EUR', symbol: '€' },
  { code: 'USD', symbol: '$' },
  { code: 'GBP', symbol: '£' },
  { code: 'CHF', symbol: 'Fr' },
  { code: 'CAD', symbol: 'C$' },
  { code: 'AUD', symbol: 'A$' },
  { code: 'JPY', symbol: '¥' },
  { code: 'CNY', symbol: '¥' },
  { code: 'MXN', symbol: 'MX$' },
  { code: 'BRL', symbol: 'R$' },
] as const

type CurrencyCode = (typeof CURRENCIES)[number]['code']

function fmtEur(n: number | null, sym = '€') {
  if (n == null || !Number.isFinite(n)) return '–'
  return `${sym}${n.toFixed(n >= 10 ? 0 : 2)}`
}

function normalizeHexColor(s: unknown) {
  if (typeof s !== 'string') return null
  const v = s.trim()
  if (!v) return null
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase()
  return null
}

function hexToRgba(hex: string, alpha: number) {
  const m = /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex)
  if (!m) return `rgba(0,0,0,${alpha})`
  const r = parseInt(m[1] ?? '00', 16)
  const g = parseInt(m[2] ?? '00', 16)
  const b = parseInt(m[3] ?? '00', 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// ── Brand color localStorage helpers ──────────────────────────────────────
const DEFAULT_BRAND_HEX = '#1a7a3a'

function localBrandKey(cid: number) {
  return `brand_color_${cid}`
}

function loadLocalBrand(cid: number) {
  try {
    return normalizeHexColor(localStorage.getItem(localBrandKey(cid))) ?? null
  } catch {
    return null
  }
}

function saveLocalBrand(cid: number, hex: string) {
  try {
    localStorage.setItem(localBrandKey(cid), hex)
  } catch { /* storage full or blocked */ }
}

// ── Currency localStorage helpers ──────────────────────────────────────────
const DEFAULT_CURRENCY = 'EUR' as const

function localCurrencyKey(cid: number) {
  return `currency_${cid}`
}

function loadLocalCurrency(cid: number): (typeof CURRENCIES)[number]['code'] | null {
  try {
    const v = localStorage.getItem(localCurrencyKey(cid))
    if (v && CURRENCIES.some((c) => c.code === v)) return v as (typeof CURRENCIES)[number]['code']
    return null
  } catch {
    return null
  }
}

function saveLocalCurrency(cid: number, code: string) {
  try {
    localStorage.setItem(localCurrencyKey(cid), code)
  } catch { /* storage full or blocked */ }
}

// ── Component ──────────────────────────────────────────────────────────────
export function DashboardPage() {
  const { signOut } = useAuth()
  const { clientId: clientIdParam } = useParams<{ clientId: string }>()
  const navigate = useNavigate()
  const cid = Number(clientIdParam) || env.clientId

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [brandSaveError, setBrandSaveError] = useState<string | null>(null)

  // Initialize brand color from localStorage immediately so it's never green on first paint
  const [client, setClient] = useState<Client | null>(() => {
    const local = loadLocalBrand(cid)
    return local ? { id: cid, primary_brand_color: local } : null
  })
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
  const [currencyCode, setCurrencyCode] = useState<CurrencyCode>(() => loadLocalCurrency(cid) ?? DEFAULT_CURRENCY)
  const currencySym = CURRENCIES.find((c) => c.code === currencyCode)?.symbol ?? '€'
  const fmtC = (n: number | null) => fmtEur(n, currencySym)

  // accordion: open skill rows (inner level)
  const [openIds, setOpenIds] = useState<Set<number>>(() => new Set())
  // accordion: open live automation groups (task-level, inside a team member)
  const [openLiveGroupIds, setOpenLiveGroupIds] = useState<Set<string>>(() => new Set())
  // accordion: open per-city rows inside a live group
  const [openCityIds, setOpenCityIds] = useState<Set<number>>(() => new Set())
  // accordion: open team members (outer level) — Carla open by default
  const [openTeamIds, setOpenTeamIds] = useState<Set<string>>(() => new Set(['carla']))
  const [howOpen, setHowOpen] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [openAuditIds, setOpenAuditIds] = useState<Set<string>>(() => new Set())

  const rowEls = useRef(new Map<number, HTMLDivElement>())
  const prevOpenIds = useRef<Set<number>>(new Set())
  const seededBrandOnce = useRef(false)

  // ── i18n ────────────────────────────────────────────────────────────────
  const t = useMemo(() => {
    const dict = {
      EN: {
        clientDashboard: 'Client Dashboard',
        howCalculated: 'How are these calculated?',
        avgResponseTime: 'Avg Response Time',
        vsManual: 'vs MANUAL',
        timeSaved: 'Time Saved',
        timeSavedHow: 'Total staff time recovered based on the agreed manual handling time per task (set per automation), multiplied by total runs processed.',
        avgRespHow: "Average response time of the automation's messages in production, compared to a 5 minute manual baseline.",
        totalSavings: 'Costs Saved',
        totalSavingsHow: '<b>Actual runs × manual cost per run</b> (€/hour × min/task ÷ 60) minus <b>automation cost × months active</b> (since first run). Only live automations with cost fields filled in are counted.',
        totalConversations: 'Customers',
        totalConversationsHow: 'Unique customer threads handled end-to-end by the automation across all live skills.',
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
        saved: 'Time Saved',
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
        timeSaved: 'Tiempo ahorrado',
        timeSavedHow:
          'Tiempo total recuperado según el tiempo manual acordado por tarea (configurado por automatización), multiplicado por el total de ejecuciones procesadas.',
        avgRespHow: 'Tiempo medio de respuesta de los mensajes en producción, comparado con una línea base manual de 5 minutos.',
        totalSavings: 'Costes ahorrados',
        totalSavingsHow: '<b>Ejecuciones reales × coste manual por ejecución</b> (€/hora × min/tarea ÷ 60) menos <b>coste de automatización × meses activos</b> (desde la primera ejecución). Solo se cuentan automatizaciones live con los campos de coste completados.',
        totalConversations: 'Clientes',
        totalConversationsHow: 'Hilos de clientes gestionados de extremo a extremo por la automatización en todas las skills activas.',
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
        saved: 'Tiempo ahorrado',
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

  const last10DayKeys = useMemo(() => {
    const keys: string[] = []
    const today = new Date()
    for (let i = 9; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(today.getDate() - i)
      keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
    }
    return keys
  }, [])

  const l10dLabels = useMemo(() => {
    const locale = lang === 'ES' ? 'es-ES' : 'en-GB'
    return last10DayKeys.map((k) => {
      const [yy, mm, dd] = k.split('-').map((v) => Number(v))
      const d = new Date(yy, (mm ?? 1) - 1, dd ?? 1, 12, 0, 0)
      return d.toLocaleDateString(locale, { day: '2-digit', month: 'short' })
    })
  }, [lang, last10DayKeys])

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
        setClient(null)
        setAutos([])
        setRuns([])
        setThreadTotalsAll({ total: null, completed: null })
        setThreadTotalsByAuto(null)
        setThreadDayCountsByAuto(null)
        setError('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
        return
      }
      const sb = supabase
      const [cRes, aRes, rRes] = await Promise.all([
        sb.from('clients').select('id,client_name,primary_brand_color,currency').eq('id', cid).maybeSingle(),
        sb
          .from('automations')
          .select('*,manual_sample_size,manual_avg_response_time,manual_execution_time_min,manual_hourly_cost,auto_monthly_cost')
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

      // Brand color: DB is the source of truth when readable; localStorage is the fallback.
      if (!cRes.error) {
        const dbColor = normalizeHexColor((cRes.data as Client | null)?.primary_brand_color) ?? null
        if (dbColor) {
          // DB has a color — use it and keep localStorage in sync
          saveLocalBrand(cid, dbColor)
          setClient((cRes.data ?? null) as Client | null)
        } else {
          // DB row has no color — seed it from localStorage or the default
          const localColor = loadLocalBrand(cid) ?? DEFAULT_BRAND_HEX
          saveLocalBrand(cid, localColor)
          setClient({ id: cid, primary_brand_color: localColor, client_name: (cRes.data as Client | null)?.client_name ?? null })
          if (!seededBrandOnce.current) {
            seededBrandOnce.current = true
            void sb.from('clients').update({ primary_brand_color: localColor }).eq('id', cid)
          }
        }
      }
      // Currency: DB is source of truth; localStorage is the fallback.
      if (!cRes.error && cRes.data) {
        const dbCurrency = (cRes.data as Client).currency
        if (dbCurrency && CURRENCIES.some((c) => c.code === dbCurrency)) {
          saveLocalCurrency(cid, dbCurrency)
          setCurrencyCode(dbCurrency as CurrencyCode)
        }
      }

      // If SELECT failed, we keep whatever is in React state (initialised from localStorage above).
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
    const timeSavedMins = Object.values(byAuto).reduce((s, a) => {
      const mins = coerceFiniteNumber(a.manual_execution_time_min) ?? COST_ASSUMPTIONS.MANUAL_MINS_PER_RUN
      return s + a.runs.length * mins
    }, 0)
    const speedPct = avgRespS > 0 ? ((COST_ASSUMPTIONS.MANUAL_RESPONSE_S - avgRespS) / COST_ASSUMPTIONS.MANUAL_RESPONSE_S) * 100 : 0
    return { avgRespS, timeSavedMins, speedPct }
  }, [runs, totalRuns, byAuto])

  // Total estimated savings for a single live automation based on actual run history:
  //   runs × manual_cost_per_run  −  auto_monthly_cost × months_active
  // months_active = span from oldest run to today (proxy for how long it's been live)
  const autoTotalSavings = (a: AutoWithRuns): number | null => {
    const mins = coerceFiniteNumber(a.manual_execution_time_min)
    const hourly = coerceFiniteNumber(a.manual_hourly_cost)
    if (mins == null || hourly == null) return null
    const manualCostPerRun = (hourly * mins) / 60
    const totalManualSaved = a.runs.length * manualCostPerRun
    const autoC = coerceFiniteNumber(a.auto_monthly_cost)
    let totalAutoCost = 0
    if (autoC != null && a.runs.length > 0) {
      const oldestRun = a.runs[a.runs.length - 1]
      const monthsActive = (Date.now() - new Date(oldestRun.created_at).getTime()) / (1000 * 60 * 60 * 24 * 30.44)
      totalAutoCost = autoC * Math.max(monthsActive, 0)
    }
    return totalManualSaved - totalAutoCost
  }

  // Client-level: sum total savings across all live (non-discovery) automations
  const clientTotalSavings = useMemo(() => {
    const liveAutos = Object.values(byAuto).filter((a) => !isDiscoveryAutomation(a))
    let total: number | null = null
    for (const a of liveAutos) {
      const s = autoTotalSavings(a)
      if (s != null) total = (total ?? 0) + s
    }
    return total
  }, [byAuto])

  // Assign automations to team members; remainder goes to "unassigned"
  const assignedIds = new Set(TEAM_MEMBERS.flatMap((m) => m.automationIds))
  const discoveryAutos = useMemo(() => {
    const rows = autos.filter((a) => isDiscoveryAutomation(a))
    return rows.sort((a, b) => displayAutomationName(a).localeCompare(displayAutomationName(b), undefined, { sensitivity: 'base' }))
  }, [autos, lang])

  const auditGroups = useMemo(() => {
    const map = new Map<string, Automation[]>()
    for (const a of discoveryAutos) {
      const base = (a.automation_name_en ?? a.automation_name ?? '').toString()
      const { task } = splitTaskCity(base)
      const bucket = map.get(task) ?? []
      bucket.push(a)
      map.set(task, bucket)
    }
    return Array.from(map.entries())
      .map(([task, rows]) => ({
        task,
        rows: rows.slice().sort((x, y) => displayAutomationName(x).localeCompare(displayAutomationName(y), undefined, { sensitivity: 'base' })),
      }))
      .sort((a, b) => a.task.localeCompare(b.task, undefined, { sensitivity: 'base' }))
  }, [discoveryAutos, lang])

  const discoveryIds = useMemo(() => new Set(discoveryAutos.map((a) => a.id)), [discoveryAutos])
  const unassignedAutos = Object.values(byAuto).filter((a) => !assignedIds.has(a.id) && !discoveryIds.has(a.id) && !isDiscoveryAutomation(a))
  const missingAssignedIds = useMemo(() => {
    if (loading) return []
    const present = new Set(autos.map((a) => a.id))
    return Array.from(assignedIds).filter((id) => !present.has(id)).sort((a, b) => a - b)
  }, [assignedIds, autos, loading])

  async function saveAutomationCosts(
    automationId: number,
    patch: Partial<Pick<Automation, 'manual_execution_time_min' | 'manual_hourly_cost' | 'auto_monthly_cost' | 'manual_sample_size' | 'manual_avg_response_time'>>,
  ) {
    if (!supabase) return
    const sb = supabase
    setAutos((prev) => prev.map((a) => (a.id === automationId ? { ...a, ...patch } : a)))
    const res = await sb
      .from('automations')
      .update(patch)
      .eq('id', automationId)
      .select('id,manual_execution_time_min,manual_hourly_cost,auto_monthly_cost,manual_sample_size,manual_avg_response_time')
    console.log('[saveAutomationCosts]', { automationId, patch, data: res.data, error: res.error })
    if (res.error) void load()
  }

  async function saveAutomationCostsGroup(
    automationIds: number[],
    patch: Partial<Pick<Automation, 'manual_execution_time_min' | 'manual_hourly_cost' | 'auto_monthly_cost' | 'manual_sample_size' | 'manual_avg_response_time'>>,
  ) {
    if (!supabase) return
    if (automationIds.length === 0) return
    const sb = supabase
    const set = new Set(automationIds)
    setAutos((prev) => prev.map((a) => (set.has(a.id) ? { ...a, ...patch } : a)))
    const res = await sb
      .from('automations')
      .update(patch)
      .in('id', automationIds)
      .select('id,manual_execution_time_min,manual_hourly_cost,auto_monthly_cost,manual_sample_size,manual_avg_response_time')
    console.log('[saveAutomationCostsGroup]', { automationIds, patch, data: res.data, error: res.error })
    if (res.error) void load()
  }

  function renderCostModel(
    a: Pick<Automation, 'id' | 'manual_execution_time_min' | 'manual_hourly_cost' | 'auto_monthly_cost' | 'manual_sample_size'>,
    opts: { monthlyRunsEstimate: number | null; showMonthlyValue?: boolean; sampleWeeksLabel?: string },
  ) {
    const manualMins = coerceFiniteNumber(a.manual_execution_time_min)
    const manualHourly = coerceFiniteNumber(a.manual_hourly_cost)
    const autoMonthly = coerceFiniteNumber(a.auto_monthly_cost)
    const monthlyRuns = opts.monthlyRunsEstimate != null && opts.monthlyRunsEstimate > 0 ? opts.monthlyRunsEstimate : null

    const manualPerRun = manualMins != null && manualHourly != null ? (manualHourly * manualMins) / 60 : null
    const autoPerRun = autoMonthly != null && monthlyRuns != null ? autoMonthly / monthlyRuns : null
    const valuePerRun = manualPerRun != null && autoPerRun != null ? manualPerRun - autoPerRun : null
    const monthlyValue = valuePerRun != null && monthlyRuns != null ? valuePerRun * monthlyRuns : null

    return (
      <div className="detail-strip" style={{ marginBottom: 12 }}>
        <div className="strip-head">
          {lang === 'ES' ? 'Modelo ROI' : 'ROI model'}
          {opts.sampleWeeksLabel ? <span style={{ marginLeft: 10, color: 'var(--text4)' }}>({opts.sampleWeeksLabel})</span> : null}
        </div>
        <div className="strip-nums three-wide">
          <div className="strip-num">
            <div className="sn-lbl">{lang === 'ES' ? 'Manual (min/tarea)' : 'Manual (min/task)'}</div>
            <input
              type="number"
              min={0}
              step={0.5}
              defaultValue={manualMins ?? ''}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim()
                const n = v === '' ? null : Number(v)
                void saveAutomationCosts(a.id, { manual_execution_time_min: Number.isFinite(n as number) ? (n as number) : null })
              }}
              style={{
                width: '100%',
                fontFamily: 'var(--mono)',
                fontSize: 12,
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '8px 10px',
                marginTop: 6,
                background: 'var(--white)',
              }}
            />
            <div className="sn-lbl" style={{ marginTop: 10 }}>
              {lang === 'ES' ? `Manual (${currencySym}/hora)` : `Manual (${currencySym}/hour)`}
            </div>
            <input
              type="number"
              min={0}
              step={1}
              defaultValue={manualHourly ?? ''}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim()
                const n = v === '' ? null : Number(v)
                void saveAutomationCosts(a.id, { manual_hourly_cost: Number.isFinite(n as number) ? (n as number) : null })
              }}
              style={{
                width: '100%',
                fontFamily: 'var(--mono)',
                fontSize: 12,
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '8px 10px',
                marginTop: 6,
                background: 'var(--white)',
              }}
            />
          </div>

          <div className="strip-num">
            <div className="sn-lbl">{lang === 'ES' ? `Auto (${currencySym}/mes)` : `Auto (${currencySym}/month)`}</div>
            <input
              type="number"
              min={0}
              step={10}
              defaultValue={autoMonthly ?? ''}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim()
                const n = v === '' ? null : Number(v)
                void saveAutomationCosts(a.id, { auto_monthly_cost: Number.isFinite(n as number) ? (n as number) : null })
              }}
              style={{
                width: '100%',
                fontFamily: 'var(--mono)',
                fontSize: 12,
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '8px 10px',
                marginTop: 6,
                background: 'var(--white)',
              }}
            />
            <div className="sn-lbl" style={{ marginTop: 10 }}>
              {lang === 'ES' ? 'Tareas/mes (estim.)' : 'Tasks/month (est.)'}
            </div>
            <div className="sn-val" style={{ marginTop: 6 }}>
              {monthlyRuns != null ? Math.round(monthlyRuns).toLocaleString() : '–'}
            </div>
            {a.manual_sample_size != null && opts.sampleWeeksLabel ? (
              <div style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text4)' }}>
                {lang === 'ES' ? 'Muestra:' : 'Sample:'} {Math.round(a.manual_sample_size).toLocaleString()}
              </div>
            ) : null}
          </div>

          <div className="strip-num">
            <div className="sn-lbl">{lang === 'ES' ? `Manual ${currencySym}/tarea` : `Manual ${currencySym}/task`}</div>
            <div className="sn-val">{fmtC(manualPerRun)}</div>

            <div className="sn-lbl" style={{ marginTop: 10 }}>
              {lang === 'ES' ? `Auto ${currencySym}/tarea` : `Auto ${currencySym}/task`}
            </div>
            <div className="sn-val">{fmtC(autoPerRun)}</div>

            <div className="sn-lbl" style={{ marginTop: 10 }}>
              {lang === 'ES' ? `Valor generado ${currencySym}/tarea` : `Value generated ${currencySym}/task`}
            </div>
            <div className="sn-val green">{fmtC(valuePerRun)}</div>

            {opts.showMonthlyValue ? (
              <>
                <div className="sn-lbl" style={{ marginTop: 10 }}>
                  {lang === 'ES' ? `Valor potencial ${currencySym}/mes` : `Potential value ${currencySym}/month`}
                </div>
                <div className="sn-val green">{fmtC(monthlyValue)}</div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

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
    const minsPerRun = coerceFiniteNumber(a.manual_execution_time_min) ?? COST_ASSUMPTIONS.MANUAL_MINS_PER_RUN
    const savedMinsByDayL10D = repliesByDayL10D.map((cnt) => cnt * minsPerRun)
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
    const monthlyRunsEstimate = manualSample != null && manualSample > 0 ? (manualSample / 5) * (52 / 12) : null

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
            <span className="val">{fmtTime(r.length * (coerceFiniteNumber(a.manual_execution_time_min) ?? COST_ASSUMPTIONS.MANUAL_MINS_PER_RUN))}</span>
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
          {/* Compact ROI model + benchmark — single row */}
          {(() => {
            const manualMins = coerceFiniteNumber(a.manual_execution_time_min)
            const manualHourly = coerceFiniteNumber(a.manual_hourly_cost)
            const autoMonthly = coerceFiniteNumber(a.auto_monthly_cost)
            const manualPerRun = manualMins != null && manualHourly != null ? (manualHourly * manualMins) / 60 : null
            const actualMonthsActive = r.length > 0
              ? Math.max((Date.now() - new Date(r[r.length - 1].created_at).getTime()) / (1000 * 60 * 60 * 24 * 30.44), 1 / 30.44)
              : null
            const actualRunsPerMonth = actualMonthsActive != null ? r.length / actualMonthsActive : null
            const manualMonthly = manualPerRun != null && actualRunsPerMonth != null ? manualPerRun * actualRunsPerMonth : null
            const totalSavings = autoTotalSavings(a)
            return (
              <div className="detail-strip cost-row-strip">
                <div className="strip-head" style={{ background: hexToRgba(brandHex, 0.10) }}>{lang === 'ES' ? 'Modelo ROI' : 'ROI model'}</div>
                <div className="cost-row-nums">
                  <div className="cost-row-cell cost-row-bm">
                    <small>{lang === 'ES' ? 'Benchmark manual · 5 semanas' : 'Manual benchmark · 5 weeks'}</small>
                    <span className="crv">
                      {manualSample != null ? manualSample.toLocaleString() : '–'} msgs · avg {manualAvg != null ? fmtDurationS(manualAvg) : '–'}
                    </span>
                  </div>
                  <div className="cost-row-cell">
                    <small>{lang === 'ES' ? 'Manual (min/tarea)' : 'Manual (min/task)'}</small>
                    <input
                      className="audit-input"
                      type="number" min={0} step={0.5}
                      defaultValue={manualMins ?? ''}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const v = e.currentTarget.value.trim()
                        const n = v === '' ? null : Number(v)
                        void saveAutomationCostsGroup([a.id], {
                          manual_execution_time_min: Number.isFinite(n as number) ? (n as number) : null,
                        })
                      }}
                    />
                  </div>
                  <div className="cost-row-cell">
                    <small>{lang === 'ES' ? `Manual (${currencySym}/hora)` : `Manual (${currencySym}/hour)`}</small>
                    <input
                      className="audit-input"
                      type="number" min={0} step={1}
                      defaultValue={manualHourly ?? ''}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const v = e.currentTarget.value.trim()
                        const n = v === '' ? null : Number(v)
                        void saveAutomationCostsGroup([a.id], {
                          manual_hourly_cost: Number.isFinite(n as number) ? (n as number) : null,
                        })
                      }}
                    />
                  </div>
                  <div className="cost-row-cell">
                    <small>{lang === 'ES' ? `Auto (${currencySym}/mes)` : `Auto (${currencySym}/mo)`}</small>
                    <input
                      className="audit-input"
                      type="number" min={0} step={10}
                      defaultValue={autoMonthly ?? ''}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const v = e.currentTarget.value.trim()
                        const n = v === '' ? null : Number(v)
                        void saveAutomationCostsGroup([a.id], {
                          auto_monthly_cost: Number.isFinite(n as number) ? (n as number) : null,
                        })
                      }}
                    />
                  </div>
                  <div className="cost-row-cell">
                    <small>{lang === 'ES' ? 'Ejecuciones' : 'Runs'}</small>
                    <span className="crv">{r.length > 0 ? r.length.toLocaleString() : '–'}</span>
                  </div>
                  <div className="cost-row-cell">
                    <small>{lang === 'ES' ? `Manual total` : `Manual total`}</small>
                    <span className="crv">{fmtC(manualPerRun != null ? r.length * manualPerRun : null)}</span>
                  </div>
                  <div className="cost-row-cell">
                    <small>{lang === 'ES' ? 'Costes ahorrados' : 'Costs saved'}</small>
                    <span className="crv green">{fmtC(totalSavings)}</span>
                  </div>
                </div>
              </div>
            )
          })()}

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
                        <div className="mini-bar-track">
                          <div className={`mini-bar ${cnt === 0 ? 'zero' : ''}`} style={{ height: `${pct}%` }}>
                            <div className="mini-bar-v">{cnt > 0 ? `${cnt}` : ''}</div>
                          </div>
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
                        <div className="mini-bar-track">
                          <div className={`mini-bar ${!showThreadStats || cnt === 0 ? 'zero' : ''}`} style={{ height: `${pct}%` }}>
                            <div className="mini-bar-v">{showThreadStats && cnt > 0 ? `${cnt}` : ''}</div>
                          </div>
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
                        <div className="hour-bar-track">
                          <div className={`hour-bar ${cnt === 0 ? 'zero' : ''}`} style={{ height: `${pct}%` }}>
                            <div className="hour-bar-v">{cnt > 0 ? `${dispPct}%` : ''}</div>
                          </div>
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
                        <div className="mini-bar-track">
                          <div className={`mini-bar ${cnt === 0 ? 'zero' : ''}`} style={{ height: `${pct}%` }}>
                            <div className="mini-bar-v">{cnt > 0 ? `${dispPct}%` : ''}</div>
                          </div>
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
                        <div className="mini-bar-track">
                          <div className={`mini-bar ${avg === 0 ? 'zero' : ''}`} style={{ height: `${pct}%` }}>
                            <div className="mini-bar-v">{avg > 0 ? `${avg.toFixed(0)}s` : ''}</div>
                          </div>
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
                        <div className="mini-bar-track">
                          <div className={`mini-bar ${mins === 0 ? 'zero' : ''}`} style={{ height: `${pct}%` }}>
                            <div className="mini-bar-v">{mins > 0 ? fmtTime(mins) : ''}</div>
                          </div>
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
                        <div className="mini-bar-track">
                          <div className={`mini-bar ${avg === 0 ? 'zero' : ''}`} style={{ height: `${pct}%` }}>
                            <div className="mini-bar-v">{avg > 0 ? `${avg.toFixed(0)}s` : ''}</div>
                          </div>
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

  function renderAuditGroupRow(group: { task: string; rows: Automation[] }) {
    const ids = group.rows.map((r) => r.id)
    const sampleSum = group.rows.reduce((s, a) => s + (coerceFiniteNumber(a.manual_sample_size) ?? 0), 0)
    const avgRespWeighted = (() => {
      const rows = group.rows
        .map((a) => ({
          n: coerceFiniteNumber(a.manual_sample_size) ?? 0,
          avg: coerceFiniteNumber(a.manual_avg_response_time),
        }))
        .filter((r) => r.n > 0 && r.avg != null)
      const denom = rows.reduce((s, r) => s + r.n, 0)
      if (denom <= 0) return null
      const numer = rows.reduce((s, r) => s + r.n * (r.avg ?? 0), 0)
      return numer / denom
    })()

    const manualMinsCommon = commonFiniteNumberOrNull(group.rows, 'manual_execution_time_min')
    const manualHourlyCommon = commonFiniteNumberOrNull(group.rows, 'manual_hourly_cost')
    const autoMonthlySum = group.rows.reduce((s, a) => s + (coerceFiniteNumber(a.auto_monthly_cost) ?? 0), 0)
    const avgRespCommon = commonFiniteNumberOrNull(group.rows, 'manual_avg_response_time')

    const sampleWeeks = 5
    const weeksPerMonth = 52 / 12 // 4.333...
    const monthlyRunsEstimate = sampleSum > 0 ? (sampleSum / sampleWeeks) * weeksPerMonth : null

    const key = `audit:${group.task}`
    const isOpen = openAuditIds.has(key)

    return (
      <div key={key} className={`auto-row ${isOpen ? 'open' : ''}`} data-auto-id={key}>
        <div className="audit-section-bar">
          <div className="audit-section-bar-name" />
          <div className="audit-section-bar-labels">
            <span className="audit-section-label">{lang === 'ES' ? 'Manual' : 'Manual'}</span>
            <span className="audit-section-label">{lang === 'ES' ? 'Auto' : 'Auto'}</span>
          </div>
          <div className="audit-section-bar-chevron" />
        </div>

        <div
          className="auto-summary audit-summary"
          onClick={() => {
            setOpenAuditIds((prev) => {
              const next = new Set(prev)
              if (next.has(key)) next.delete(key)
              else next.add(key)
              return next
            })
          }}
        >
          <div className="audit-name">
            <div className="auto-name">{group.task}</div>
            <div className="audit-sub">
              {group.rows.length}{' '}
              {lang === 'ES'
                ? group.rows.length === 1
                  ? 'ubicación'
                  : 'ubicaciones'
                : group.rows.length === 1
                  ? 'location'
                  : 'locations'}
            </div>
          </div>

          <div className="audit-groups">
            {/* MANUAL section */}
            <div className="audit-group audit-group-manual">
              <div className="audit-group-cols">
                <div className="auto-stat audit-stat">
                  <small>{lang === 'ES' ? 'Muestra (msgs)' : 'Sample (msgs)'}</small>
                  <span className="val">
                    <input
                      className="audit-input"
                      type="number"
                      min={0}
                      step={1}
                      defaultValue={sampleSum > 0 ? Math.round(sampleSum) : ''}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const v = e.currentTarget.value.trim()
                        const n = v === '' ? null : Number(v)
                        if (!Number.isFinite(n as number)) return
                        const perCity = (n as number) / Math.max(ids.length, 1)
                        void saveAutomationCostsGroup(ids, { manual_sample_size: perCity })
                      }}
                    />
                  </span>
                </div>
                <div className="auto-stat audit-stat hl">
                  <small>{lang === 'ES' ? 'Resp. media (s)' : 'Avg resp (s)'}</small>
                  <span className="val">
                    <input
                      className="audit-input"
                      type="number"
                      min={0}
                      step={1}
                      defaultValue={avgRespCommon ?? ''}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const v = e.currentTarget.value.trim()
                        const n = v === '' ? null : Number(v)
                        void saveAutomationCostsGroup(ids, {
                          manual_avg_response_time: Number.isFinite(n as number) ? (n as number) : null,
                        })
                      }}
                    />
                  </span>
                </div>
                <div className="auto-stat audit-stat">
                  <small>{lang === 'ES' ? 'Min/tarea' : 'Min/task'}</small>
                  <span className="val">
                    <input
                      className="audit-input"
                      type="number"
                      min={0}
                      step={0.5}
                      defaultValue={manualMinsCommon ?? ''}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const v = e.currentTarget.value.trim()
                        const n = v === '' ? null : Number(v)
                        void saveAutomationCostsGroup(ids, {
                          manual_execution_time_min: Number.isFinite(n as number) ? (n as number) : null,
                        })
                      }}
                    />
                  </span>
                </div>
                <div className="auto-stat audit-stat">
                  <small>{lang === 'ES' ? `${currencySym}/hora` : `${currencySym}/hour`}</small>
                  <span className="val">
                    <input
                      className="audit-input"
                      type="number"
                      min={0}
                      step={1}
                      defaultValue={manualHourlyCommon ?? ''}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const v = e.currentTarget.value.trim()
                        const n = v === '' ? null : Number(v)
                        void saveAutomationCostsGroup(ids, { manual_hourly_cost: Number.isFinite(n as number) ? (n as number) : null })
                      }}
                    />
                  </span>
                </div>
                <div className="auto-stat audit-stat">
                  <small>{lang === 'ES' ? `Manual ${currencySym}/mes` : `Manual ${currencySym}/mo`}</small>
                  <span className="val">
                    {(() => {
                      if (manualMinsCommon == null || manualHourlyCommon == null || monthlyRunsEstimate == null) return '–'
                      const manualPerRun = (manualHourlyCommon * manualMinsCommon) / 60
                      return fmtC(manualPerRun * monthlyRunsEstimate)
                    })()}
                  </span>
                </div>
              </div>
            </div>

            {/* AUTO section */}
            <div className="audit-group audit-group-auto">
              <div className="audit-group-cols">
                <div className="auto-stat audit-stat">
                  <small>{lang === 'ES' ? `Auto ${currencySym}/mes` : `Auto ${currencySym}/mo`}</small>
                  <span className="val">
                    <input
                      className="audit-input"
                      type="number"
                      min={0}
                      step={10}
                      defaultValue={autoMonthlySum > 0 ? autoMonthlySum : ''}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const v = e.currentTarget.value.trim()
                        const n = v === '' ? null : Number(v)
                        if (!Number.isFinite(n as number)) return
                        const perCity = (n as number) / Math.max(ids.length, 1)
                        void saveAutomationCostsGroup(ids, { auto_monthly_cost: perCity })
                      }}
                    />
                  </span>
                </div>
                <div className="auto-stat audit-stat audit-stat-savings good">
                  <small>{lang === 'ES' ? 'Potencial de ahorro' : 'Savings potential'}</small>
                  <span className="val">
                    {(() => {
                      if (manualMinsCommon == null || manualHourlyCommon == null || monthlyRunsEstimate == null)
                        return <span className="audit-savings-val">–</span>
                      const manualPerRun = (manualHourlyCommon * manualMinsCommon) / 60
                      const manualMonthly = manualPerRun * monthlyRunsEstimate
                      const savings = fmtC(manualMonthly - autoMonthlySum)
                      return (
                        <span className="audit-savings-val">
                          {savings}
                          <span className="audit-savings-suffix">{lang === 'ES' ? '/ mes' : '/ mo'}</span>
                        </span>
                      )
                    })()}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {chevronSvg()}
        </div>

        <div className="auto-detail audit-detail">
          <div className="audit-detail-inner">
            <div className="audit-detail-title">{lang === 'ES' ? 'Por ciudad' : 'By city'}</div>
            <div className="audit-city-grid">
              {group.rows.map((a) => {
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
                const hangingPct = totalThreads != null && totalThreads > 0 && hangingThreads != null ? (hangingThreads / totalThreads) * 100 : null

                const base = (a.automation_name_en ?? a.automation_name ?? '').toString()
                const { city } = splitTaskCity(base)
                const displayCity = city ?? displayAutomationName(a)

                const sampleSize = coerceFiniteNumber(a.manual_sample_size)
                const manualAvgResp = coerceFiniteNumber(a.manual_avg_response_time)

                return (
                  <div key={a.id} className="audit-city-card">
                    <div className="audit-city-name">{displayCity}</div>
                    <div className="audit-city-metrics">
                      <div className="audit-city-metric">
                        <div className="audit-city-lbl">{lang === 'ES' ? 'Mensajes' : 'Messages'}</div>
                        <div className="audit-city-val">
                          <input
                            className="audit-input"
                            type="number"
                            min={0}
                            step={1}
                            defaultValue={sampleSize != null ? Math.round(sampleSize) : ''}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={(e) => {
                              const v = e.currentTarget.value.trim()
                              const n = v === '' ? null : Number(v)
                              void saveAutomationCosts(a.id, {
                                manual_sample_size: Number.isFinite(n as number) ? (n as number) : null,
                              })
                            }}
                          />
                        </div>
                      </div>
                      <div className="audit-city-metric">
                        <div className="audit-city-lbl">{lang === 'ES' ? 'T. resp. medio (s)' : 'Avg resp time (s)'}</div>
                        <div className="audit-city-val">
                          <input
                            className="audit-input"
                            type="number"
                            min={0}
                            step={1}
                            defaultValue={manualAvgResp ?? ''}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={(e) => {
                              const v = e.currentTarget.value.trim()
                              const n = v === '' ? null : Number(v)
                              void saveAutomationCosts(a.id, {
                                manual_avg_response_time: Number.isFinite(n as number) ? (n as number) : null,
                              })
                            }}
                          />
                        </div>
                      </div>
                      <div className="audit-city-metric">
                        <div className="audit-city-lbl">{lang === 'ES' ? 'Hilos' : 'Threads'}</div>
                        <div className="audit-city-val">{totalThreads != null ? Math.round(totalThreads) : '–'}</div>
                      </div>
                      <div className="audit-city-metric">
                        <div className="audit-city-lbl">{lang === 'ES' ? 'Completadas' : 'Completed'}</div>
                        <div className="audit-city-val">{completionPct != null ? `${completionPct.toFixed(0)}%` : '–'}</div>
                      </div>
                      <div className="audit-city-metric">
                        <div className="audit-city-lbl">{lang === 'ES' ? 'Hanging' : 'Hanging'}</div>
                        <div className="audit-city-val">{hangingPct != null ? `${hangingPct.toFixed(0)}%` : '–'}</div>
                      </div>
                      <div className="audit-city-metric">
                        <div className="audit-city-lbl">{lang === 'ES' ? 'Tiempo para cerrar' : 'Avg time to close'}</div>
                        <div className="audit-city-val">{avgTimeToCompleteS != null ? fmtDurationS(avgTimeToCompleteS) : '–'}</div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Live automation group row (task with per-city breakdown) ─────────────
  function renderLiveGroupRow(groupKey: string, task: string, groupAutos: AutoWithRuns[]) {
    const ids = groupAutos.map((a) => a.id)
    const allRuns = groupAutos.flatMap((a) => a.runs)
    const totalRuns = allRuns.length
    const avgRespS = totalRuns > 0 ? allRuns.reduce((s, r) => s + (r.response_time ?? 0), 0) / totalRuns : 0
    const timeSavedMins = groupAutos.reduce((s, a) => s + a.runs.length * (coerceFiniteNumber(a.manual_execution_time_min) ?? COST_ASSUMPTIONS.MANUAL_MINS_PER_RUN), 0)
    const lastCreatedAt = allRuns.length > 0 ? allRuns[0].created_at : null

    const hasLive = groupAutos.some((a) => (a.status ?? '').toString().toLowerCase() === 'live')
    const hasTesting = groupAutos.some((a) => (a.status ?? '').toString().toLowerCase() === 'testing')
    const statusClass = hasLive ? 'live' : hasTesting ? 'testing' : 'offline'
    const statusLabel = hasLive ? t.activeStatus : hasTesting ? t.testingStatus : t.inactiveStatus

    const manualMinsCommon = commonFiniteNumberOrNull(groupAutos, 'manual_execution_time_min')
    const manualHourlyCommon = commonFiniteNumberOrNull(groupAutos, 'manual_hourly_cost')
    const autoMonthlySum = groupAutos.reduce((s, a) => s + (coerceFiniteNumber(a.auto_monthly_cost) ?? 0), 0)

    const sampleSum = groupAutos.reduce((s, a) => s + (coerceFiniteNumber(a.manual_sample_size) ?? 0), 0)
    const manualAvgWeighted = (() => {
      const rows = groupAutos
        .map((a) => ({ n: coerceFiniteNumber(a.manual_sample_size) ?? 0, avg: coerceFiniteNumber(a.manual_avg_response_time) }))
        .filter((r) => r.n > 0 && r.avg != null)
      const denom = rows.reduce((s, r) => s + r.n, 0)
      if (denom <= 0) return null
      return rows.reduce((s, r) => s + r.n * (r.avg ?? 0), 0) / denom
    })()
    const manualPerRun = manualMinsCommon != null && manualHourlyCommon != null ? (manualHourlyCommon * manualMinsCommon) / 60 : null
    const actualGroupMonthsActive = allRuns.length > 0
      ? Math.max((Date.now() - new Date(allRuns[allRuns.length - 1].created_at).getTime()) / (1000 * 60 * 60 * 24 * 30.44), 1 / 30.44)
      : null
    const actualGroupRunsPerMonth = actualGroupMonthsActive != null ? allRuns.length / actualGroupMonthsActive : null
    const manualMonthly = manualPerRun != null && actualGroupRunsPerMonth != null ? manualPerRun * actualGroupRunsPerMonth : null

    let groupTotalSavings: number | null = null
    for (const a of groupAutos) {
      const s = autoTotalSavings(a)
      if (s != null) groupTotalSavings = (groupTotalSavings ?? 0) + s
    }

    const isOpen = openLiveGroupIds.has(groupKey)

    return (
      <div key={groupKey} className={`auto-row ${isOpen ? 'open' : ''}`}>
        <div
          className="auto-summary"
          onClick={() => setOpenLiveGroupIds((prev) => {
            const next = new Set(prev)
            if (next.has(groupKey)) next.delete(groupKey)
            else next.add(groupKey)
            return next
          })}
        >
          <div className="auto-name" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {task}
              <span className={`row-live ${statusClass}`}>
                <span className={`live-dot ${statusClass}`}></span>
                {statusLabel}
              </span>
              {groupAutos.length > 1 && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text4)' }}>
                  {groupAutos.length} {lang === 'ES' ? 'ciudades' : 'cities'}
                </span>
              )}
            </div>
            <div className="team-member-role">{lang === 'ES' ? 'Tarea' : 'Task'}</div>
          </div>
          <div className="auto-stat">
            <small>{t.msgs}</small>
            <span className="val">{totalRuns}</span>
          </div>
          <div className="auto-stat hl">
            <small>{t.avg}</small>
            <span className="val">{avgRespS > 0 ? `${avgRespS.toFixed(0)}s` : '–'}</span>
          </div>
          <div className="auto-stat good">
            <small>{t.saved}</small>
            <span className="val">{fmtTime(timeSavedMins)}</span>
          </div>
          <div className="auto-stat good">
            <small>{lang === 'ES' ? 'Costes ahorrados' : 'Costs saved'}</small>
            <span className="val">{groupTotalSavings != null ? fmtC(groupTotalSavings) : '–'}</span>
          </div>
          <div className="auto-stat">
            <small>{t.lastMsg}</small>
            <span className="val">{lastCreatedAt ? relLang(lastCreatedAt) : '–'}</span>
          </div>
          {chevronSvg()}
        </div>

        <div className="auto-detail">
          {/* Two side-by-side panels: benchmark + ROI model */}
          <div className="cost-panels">
            {/* Panel 1 – Manual performance benchmark */}
            <div className="detail-strip benchmark">
              <div className="strip-head" style={{ background: hexToRgba(brandHex, 0.10) }}>
                {lang === 'ES' ? 'Benchmark manual · 5 sem.' : 'Manual benchmark · 5 wks'}
              </div>
              <div className="cost-row-nums">
                <div className="cost-row-cell">
                  <small>{lang === 'ES' ? 'Muestra' : 'Sample size'}</small>
                  <span className="crv">{sampleSum > 0 ? sampleSum.toLocaleString() : '–'}</span>
                </div>
                <div className="cost-row-cell">
                  <small>{lang === 'ES' ? 'Tiempo medio resp.' : 'Avg resp time'}</small>
                  <span className="crv">{manualAvgWeighted != null ? fmtDurationS(manualAvgWeighted) : '–'}</span>
                </div>
              </div>
            </div>

            {/* Panel 2 – ROI model inputs + computed */}
            <div className="detail-strip">
              <div className="strip-head" style={{ background: hexToRgba(brandHex, 0.10) }}>
                {lang === 'ES' ? 'Modelo ROI' : 'ROI model'}
              </div>
              <div className="cost-row-nums">
                <div className="cost-row-cell">
                  <small>{lang === 'ES' ? 'Manual (min/tarea)' : 'Manual (min/task)'}</small>
                  <input
                    className="audit-input"
                    type="number" min={0} step={0.5}
                    defaultValue={manualMinsCommon ?? ''}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      const v = e.currentTarget.value.trim()
                      const n = v === '' ? null : Number(v)
                      void saveAutomationCostsGroup(ids, { manual_execution_time_min: Number.isFinite(n as number) ? (n as number) : null })
                    }}
                  />
                </div>
                <div className="cost-row-cell">
                  <small>{lang === 'ES' ? `Manual (${currencySym}/hora)` : `Manual (${currencySym}/hour)`}</small>
                  <input
                    className="audit-input"
                    type="number" min={0} step={1}
                    defaultValue={manualHourlyCommon ?? ''}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      const v = e.currentTarget.value.trim()
                      const n = v === '' ? null : Number(v)
                      void saveAutomationCostsGroup(ids, { manual_hourly_cost: Number.isFinite(n as number) ? (n as number) : null })
                    }}
                  />
                </div>
                <div className="cost-row-cell">
                  <small>{lang === 'ES' ? `Auto total (${currencySym}/mes)` : `Auto total (${currencySym}/mo)`}</small>
                  <input
                    className="audit-input"
                    type="number" min={0} step={10}
                    defaultValue={autoMonthlySum > 0 ? autoMonthlySum : ''}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      const v = e.currentTarget.value.trim()
                      const n = v === '' ? null : Number(v)
                      if (!Number.isFinite(n as number)) return
                      const perCity = (n as number) / Math.max(ids.length, 1)
                      void saveAutomationCostsGroup(ids, { auto_monthly_cost: perCity })
                    }}
                  />
                </div>
                <div className="cost-row-cell">
                  <small>{lang === 'ES' ? 'Ejecuciones' : 'Runs'}</small>
                  <span className="crv">{totalRuns > 0 ? totalRuns.toLocaleString() : '–'}</span>
                </div>
                <div className="cost-row-cell">
                  <small>Manual total</small>
                  <span className="crv">{fmtC(manualPerRun != null ? totalRuns * manualPerRun : null)}</span>
                </div>
                <div className="cost-row-cell">
                  <small>{lang === 'ES' ? 'Costes ahorrados' : 'Costs saved'}</small>
                  <span className="crv green">{fmtC(groupTotalSavings)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Per-city breakdown — accordion rows */}
          {groupAutos.length > 1 && (
            <div className="city-rows">
              {groupAutos.map((a) => {
                const base = (a.automation_name_en ?? a.automation_name ?? '').toString()
                const { city } = splitTaskCity(base)
                const cityRuns = a.runs.length
                const cityAvg = cityRuns > 0 ? a.runs.reduce((s, r) => s + (r.response_time ?? 0), 0) / cityRuns : null
                const citySavings = autoTotalSavings(a)
                const isCityOpen = openCityIds.has(a.id)

                const cityRepliesByDayL10D = (() => {
                  const m: Record<string, number> = {}
                  for (const x of a.runs) {
                    const d = new Date(x.created_at)
                    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                    m[key] = (m[key] ?? 0) + 1
                  }
                  return last10DayKeys.map((k) => m[k] ?? 0)
                })()

                const cityAvgRespByDayL10D = (() => {
                  const m: Record<string, { total: number; timeSum: number }> = {}
                  for (const x of a.runs) {
                    const d = new Date(x.created_at)
                    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                    m[key] ??= { total: 0, timeSum: 0 }
                    m[key].total++
                    m[key].timeSum += x.response_time ?? 0
                  }
                  return last10DayKeys.map((k) => {
                    const v = m[k]
                    if (!v || v.total === 0) return 0
                    return v.timeSum / v.total
                  })
                })()

                const cityMinsPerRun = coerceFiniteNumber(a.manual_execution_time_min) ?? COST_ASSUMPTIONS.MANUAL_MINS_PER_RUN
                const citySavedMinsByDayL10D = cityRepliesByDayL10D.map((cnt) => cnt * cityMinsPerRun)

                const maxCityRepliesL10D = Math.max(...cityRepliesByDayL10D, 1)
                const maxCityAvgRespL10D = Math.max(...cityAvgRespByDayL10D, 1)
                const maxCitySavedMinsL10D = Math.max(...citySavedMinsByDayL10D, 1)

                const cityStatusLower = (a.status ?? '').toString().toLowerCase()
                const cityIsLive = cityStatusLower === 'live'
                const cityIsTesting = cityStatusLower === 'testing'
                const cityStatusClass = cityIsLive ? 'live' : cityIsTesting ? 'testing' : 'offline'
                const cityStatusLabel = cityIsLive ? t.activeStatus : cityIsTesting ? t.testingStatus : t.inactiveStatus

                return (
                  <div key={a.id} className={`city-row ${isCityOpen ? 'open' : ''}`}>
                    <div
                      className="city-row-summary"
                      onClick={() => setOpenCityIds((prev) => {
                        const next = new Set(prev)
                        if (next.has(a.id)) next.delete(a.id)
                        else next.add(a.id)
                        return next
                      })}
                    >
                      <div className="city-row-name">
                        {city ?? displayAutomationName(a)}
                        <span className={`row-live ${cityStatusClass}`}>
                          <span className={`live-dot ${cityStatusClass}`}></span>
                          {cityStatusLabel}
                        </span>
                      </div>
                      <div className="auto-stat">
                        <small>{t.msgs}</small>
                        <span className="val">{cityRuns > 0 ? cityRuns : '–'}</span>
                      </div>
                      <div className="auto-stat hl">
                        <small>{t.avg}</small>
                        <span className="val">{cityAvg != null ? `${cityAvg.toFixed(0)}s` : '–'}</span>
                      </div>
                      <div className="auto-stat good">
                        <small>{t.saved}</small>
                        <span className="val">{cityRuns > 0 ? fmtTime(cityRuns * (coerceFiniteNumber(a.manual_execution_time_min) ?? COST_ASSUMPTIONS.MANUAL_MINS_PER_RUN)) : '–'}</span>
                      </div>
                      <div className="auto-stat good">
                        <small>{lang === 'ES' ? 'Costes ahorra.' : 'Costs saved'}</small>
                        <span className="val">{citySavings != null ? fmtC(citySavings) : '–'}</span>
                      </div>
                      <div className="auto-stat">
                        <small>{t.lastMsg}</small>
                        <span className="val">{a.runs.length > 0 ? relLang(a.runs[0].created_at) : '–'}</span>
                      </div>
                      {chevronSvg()}
                    </div>

                    <div className="city-row-detail">
                      <div className="strip-charts city-charts">
                        <div className="strip-chart">
                          <div className="mini-chart-title">{t.repliesL10D}</div>
                          <div className="mini-bars">
                            {cityRepliesByDayL10D.map((cnt, i) => {
                              const pct = (cnt / maxCityRepliesL10D) * 100
                              return (
                                <div className="mini-bar-g" key={last10DayKeys[i]}>
                                  <div className="mini-bar-track">
                                    <div className={`mini-bar ${cnt === 0 ? 'zero' : ''}`} style={{ height: `${pct}%` }}>
                                      <div className="mini-bar-v">{cnt > 0 ? `${cnt}` : ''}</div>
                                    </div>
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
                            {citySavedMinsByDayL10D.map((mins, i) => {
                              const pct = (mins / maxCitySavedMinsL10D) * 100
                              return (
                                <div className="mini-bar-g" key={last10DayKeys[i]}>
                                  <div className="mini-bar-track">
                                    <div className={`mini-bar ${mins === 0 ? 'zero' : ''}`} style={{ height: `${pct}%` }}>
                                      <div className="mini-bar-v">{mins > 0 ? fmtTime(mins) : ''}</div>
                                    </div>
                                  </div>
                                  <div className="mini-bar-lbl">{l10dLabels[i]}</div>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                        <div className="strip-chart">
                          <div className="mini-chart-title">{t.avgRespByDay}</div>
                          <div className="mini-bars">
                            {cityAvgRespByDayL10D.map((avg, i) => {
                              const pct = (avg / maxCityAvgRespL10D) * 100
                              return (
                                <div className="mini-bar-g" key={last10DayKeys[i]}>
                                  <div className="mini-bar-track">
                                    <div className={`mini-bar ${avg === 0 ? 'zero' : ''}`} style={{ height: `${pct}%` }}>
                                      <div className="mini-bar-v">{avg > 0 ? `${avg.toFixed(0)}s` : ''}</div>
                                    </div>
                                  </div>
                                  <div className="mini-bar-lbl">{l10dLabels[i]}</div>
                                </div>
                              )
                            })}
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
      </div>
    )
  }

  // ── Team member header renderer ───────────────────────────────────────────
  function renderTeamMember(member: (typeof TEAM_MEMBERS)[number]) {
    const memberAutos = (member.automationIds.map((id) => byAuto[id]).filter(Boolean) as AutoWithRuns[]).filter((a) => !isDiscoveryAutomation(a))
    const memberRuns = memberAutos.flatMap((a) => a.runs)
    const totalReplies = memberRuns.length
    const avgRespS = totalReplies > 0 ? memberRuns.reduce((s, r) => s + (r.response_time ?? 0), 0) / totalReplies : 0
    const timeSavedMins = memberAutos.reduce((s, a) => s + a.runs.length * (coerceFiniteNumber(a.manual_execution_time_min) ?? COST_ASSUMPTIONS.MANUAL_MINS_PER_RUN), 0)
    const perfPct = avgRespS > 0 ? ((COST_ASSUMPTIONS.MANUAL_RESPONSE_S - avgRespS) / COST_ASSUMPTIONS.MANUAL_RESPONSE_S) * 100 : 0
    const memberSavings = (() => {
      let total: number | null = null
      for (const a of memberAutos) {
        const s = autoTotalSavings(a)
        if (s != null) total = (total ?? 0) + s
      }
      return total
    })()
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
          <div className="team-stat">
            <span className={`ts-val ${memberSavings != null && memberSavings > 0 ? 'green' : 'dim'}`}>
              {memberSavings != null ? fmtC(memberSavings) : '–'}
            </span>
            <small>{lang === 'ES' ? 'Costes ahorrados' : 'Costs saved'}</small>
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
                {(() => {
                  const groups = new Map<string, AutoWithRuns[]>()
                  for (const a of memberAutos) {
                    const base = (a.automation_name_en ?? a.automation_name ?? '').toString()
                    const { task } = splitTaskCity(base)
                    const bucket = groups.get(task) ?? []
                    bucket.push(a)
                    groups.set(task, bucket)
                  }
                  return Array.from(groups.entries())
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([task, rows]) => renderLiveGroupRow(`${member.id}:${task}`, task, rows))
                })()}
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
  const brandHex = normalizeHexColor(client?.primary_brand_color) ?? DEFAULT_BRAND_HEX
  const brandBg = hexToRgba(brandHex, 0.13)
  const [brandHexDraft, setBrandHexDraft] = useState(brandHex)
  const [brandPickerOpen, setBrandPickerOpen] = useState(false)
  const brandPickerWrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setBrandHexDraft(brandHex)
  }, [brandHex])

  useEffect(() => {
    if (!brandPickerOpen) return
    const onDown = (e: MouseEvent) => {
      const el = brandPickerWrapRef.current
      if (!el) return
      if (e.target instanceof Node && el.contains(e.target)) return
      setBrandPickerOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [brandPickerOpen])

  async function saveClientCurrency(code: CurrencyCode) {
    saveLocalCurrency(cid, code)
    if (!supabase) return
    await supabase.from('clients').update({ currency: code }).eq('id', cid)
  }

  async function saveClientBrandColor(next: unknown) {
    const hex = normalizeHexColor(next)
    if (!hex) return
    setBrandSaveError(null)
    // Apply immediately — localStorage keeps it across reloads even if DB fails
    saveLocalBrand(cid, hex)
    setClient((prev) => (prev ? { ...prev, primary_brand_color: hex } : { id: cid, primary_brand_color: hex }))
    if (!supabase) return
    const res = await supabase.from('clients').update({ primary_brand_color: hex }).eq('id', cid).select('id,primary_brand_color').maybeSingle()
    if (res.error) {
      setBrandSaveError(`DB error: ${res.error.message}`)
      return
    }
    const saved = normalizeHexColor(res.data?.primary_brand_color) ?? null
    if (saved !== hex) {
      setBrandSaveError('Color saved locally but DB did not confirm (check RLS UPDATE policy for clients table).')
    }
  }

  return (
    <div
      className="page"
      style={{
        // Set all brand/green vars directly so .kpi-val.green, .auto-stat.good etc.
        // always pick up the live brand color without relying on :root indirection.
        ['--brand' as never]: brandHex,
        ['--brand-bg' as never]: brandBg,
        ['--green' as never]: brandHex,
        ['--green-bg' as never]: brandBg,
      }}
    >
      <header className="header">
        <div className="wrap">
          <a className="logo" href="#">
            <img src="/logos/arkflow-logo.svg" alt="Arkflow" className="logo-img" />
          </a>
          <div className="header-r">
            <div className="header-ctls">
              <select
                className="hdr-ctl hdr-currency"
                value={currencyCode}
                onChange={(e) => {
                  const code = e.currentTarget.value as CurrencyCode
                  setCurrencyCode(code)
                  void saveClientCurrency(code)
                }}
                aria-label="Currency"
              >
                {CURRENCIES.map((c) => (
                  <option key={c.code} value={c.code}>{c.code}</option>
                ))}
              </select>

              <div className="brand-picker" ref={brandPickerWrapRef}>
                <button
                  type="button"
                  className="hdr-ctl hdr-btn brand-btn"
                  aria-haspopup="dialog"
                  aria-expanded={brandPickerOpen}
                  onClick={() => setBrandPickerOpen((v) => !v)}
                  title={lang === 'ES' ? 'Color de marca' : 'Brand color'}
                >
                  <span className="brand-swatch" style={{ background: brandHex }} aria-hidden="true" />
                </button>

                {brandPickerOpen ? (
                  <div className="brand-pop" role="dialog" aria-label={lang === 'ES' ? 'Selector de color' : 'Color picker'}>
                    <div className="brand-pop-row">
                      <label className="brand-pop-lbl">{lang === 'ES' ? 'Picker' : 'Picker'}</label>
                      <input
                        type="color"
                        className="brand-color-input"
                        value={brandHex}
                        onChange={(e) => void saveClientBrandColor(e.currentTarget.value)}
                        aria-label={lang === 'ES' ? 'Color de marca' : 'Brand color'}
                      />
                    </div>
                    <div className="brand-pop-row">
                      <label className="brand-pop-lbl">HEX</label>
                      <input
                        type="text"
                        inputMode="text"
                        spellCheck={false}
                        className="brand-hex-input"
                        value={brandHexDraft}
                        onChange={(e) => setBrandHexDraft(e.currentTarget.value)}
                        onBlur={() => {
                          const norm = normalizeHexColor(brandHexDraft)
                          if (norm) void saveClientBrandColor(norm)
                          else setBrandHexDraft(brandHex)
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter') return
                          ;(e.currentTarget as HTMLInputElement).blur()
                          setBrandPickerOpen(false)
                        }}
                        placeholder={DEFAULT_BRAND_HEX}
                        aria-label={lang === 'ES' ? 'HEX de marca' : 'Brand HEX'}
                      />
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="hdr-seg">
                <button
                  onClick={() => setLang('EN')}
                  className={`hdr-seg-btn ${lang === 'EN' ? 'active' : ''}`}
                >
                  EN
                </button>
                <button
                  onClick={() => setLang('ES')}
                  className={`hdr-seg-btn ${lang === 'ES' ? 'active' : ''}`}
                >
                  ES
                </button>
              </div>
              <button
                onClick={() => void signOut()}
                className="hdr-ctl hdr-btn"
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
              <div className="kpi-lbl">{t.avgResponseTime}</div>
            </div>
            <div className="kpi">
              <div className="kpi-val green" id="kTimeSaved">
                {fmtTime(kpis.timeSavedMins)}
              </div>
              <div className="kpi-lbl">{t.timeSaved}</div>
            </div>
            <div className="kpi">
              <div className={`kpi-val ${clientTotalSavings != null && clientTotalSavings > 0 ? 'green' : ''}`} id="kSavings">
                {clientTotalSavings != null ? fmtC(clientTotalSavings) : '–'}
              </div>
              <div className="kpi-lbl">{lang === 'ES' ? 'Costes ahorrados' : 'Costs saved'}</div>
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

          {brandSaveError ? (
            <div className="error-msg" style={{ marginTop: 12 }}>
              Failed to save brand color to DB. {brandSaveError}
            </div>
          ) : null}

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
                <div className="how-name">{t.totalSavings}</div>
                <div className="how-desc" dangerouslySetInnerHTML={{ __html: t.totalSavingsHow }} />
              </div>
              <div className="how-item">
                <div className="how-name">{t.totalConversations}</div>
                <div className="how-desc">{t.totalConversationsHow}</div>
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
                      <span className="ts-val">{auditGroups.length}</span>
                      <small>{lang === 'ES' ? 'Oportunidades' : 'Opportunities'}</small>
                    </div>
                    {chevronSvg()}
                  </div>
                  <div className="team-member-body">
                    <div className="team-member-skills">
                      <div className="auto-list">
                        {auditGroups.map((g) => renderAuditGroupRow(g))}
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
                        {(() => {
                          const groups = new Map<string, AutoWithRuns[]>()
                          for (const a of unassignedAutos) {
                            const base = (a.automation_name_en ?? a.automation_name ?? '').toString()
                            const { task } = splitTaskCity(base)
                            const bucket = groups.get(task) ?? []
                            bucket.push(a)
                            groups.set(task, bucket)
                          }
                          return Array.from(groups.entries())
                            .sort(([a], [b]) => a.localeCompare(b))
                            .map(([task, rows]) => renderLiveGroupRow(`unassigned:${task}`, task, rows))
                        })()}
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
