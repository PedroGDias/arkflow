import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { env } from '../lib/env'
import { supabase } from '../lib/supabase'
import type { Automation, AutomationSummary, Client, ClientKpis, Run, TeamMember } from '../lib/types'
import { clientLogoUrl, uploadClientLogo } from '../lib/clientLogos'
import { COST_ASSUMPTIONS, fmtTime, rel } from '../lib/roiMath'
import { Tooltip } from '../components/Tooltip'
import { ChangePassword } from '../components/ChangePassword'
import { ErpIngestionModal } from '../components/ErpIngestionModal'

type AutoWithSummary = Automation & { summary: AutomationSummary | null }

/** Inline fill so chart bars always match client brand (avoids UA / variable quirks). */
function chartBarFillStyle(heightPct: number, isZero: boolean, brandHex: string): CSSProperties {
  return {
    height: `${heightPct}%`,
    backgroundColor: isZero ? 'transparent' : brandHex,
  }
}

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
  if (!Number.isFinite(seconds) || seconds < 0) return '-'
  if (seconds >= 24 * 60 * 60) {
    const totalHours = Math.round(seconds / 3600)
    const d = Math.floor(totalHours / 24)
    const h = totalHours % 24
    return h > 0 ? `${d}d ${h}h` : `${d}d`
  }
  if (seconds < 60) return `${Math.round(seconds)}s`
  return fmtTime(seconds / 60)
}

/** Fixed-width HH:MM:SS for durations stored as seconds (e.g. opportunities / audit). */
function fmtSecondsHMS(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) return ''
  const s = Math.floor(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(r)}`
}

/** Accepts plain seconds or HH:MM:SS / MM:SS; returns integer seconds for DB. */
function parseSecondsHMSOrRaw(s: string): number | null {
  const t = s.trim()
  if (!t) return null
  if (/^\d+$/.test(t)) {
    const n = Number(t)
    return Number.isFinite(n) ? Math.round(n) : null
  }
  const parts = t.split(':').map((p) => p.trim())
  if (parts.length === 3) {
    const h = Number(parts[0])
    const m = Number(parts[1])
    const sec = Number(parts[2])
    if ([h, m, sec].every((x) => Number.isFinite(x)) && m < 60 && sec < 60) return Math.round(h * 3600 + m * 60 + sec)
  }
  if (parts.length === 2) {
    const m = Number(parts[0])
    const sec = Number(parts[1])
    if ([m, sec].every((x) => Number.isFinite(x)) && sec < 60) return Math.round(m * 60 + sec)
  }
  return null
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
  key: keyof Pick<Automation, 'manual_execution_time_min' | 'manual_hourly_cost' | 'manual_avg_response_time'>,
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
  if (n == null || !Number.isFinite(n)) return '-'
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
  const { signOut, isInternal, accessibleClientIds, manageableClientIds } = useAuth()
  // Only users who can reach more than one client get the "All clients" link /
  // picker. Single-client users never see the client overview page.
  const canSwitchClients = isInternal || (accessibleClientIds?.length ?? 0) > 1
  // Designated client-side managers (non-internal) get a "Manage access" link.
  // Internal users use the full /admin page instead.
  const canManageMembers = !isInternal && (manageableClientIds?.length ?? 0) > 0
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
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([])
  const [memberAutomationIds, setMemberAutomationIds] = useState<Record<number, number[]>>({})
  const [autos, setAutos] = useState<Automation[]>([])
  const [clientKpis, setClientKpis] = useState<ClientKpis | null>(null)
  const [autoSummaries, setAutoSummaries] = useState<Record<number, AutomationSummary>>({})
  const [threadTotalsAll, setThreadTotalsAll] = useState<{ total: number | null; completed: number | null }>({ total: null, completed: null })
  const [threadTotalsByAuto, setThreadTotalsByAuto] = useState<Record<number, { total: number; completed: number }> | null>(null)
  // Per-automation 10-element daily counts, oldest→today (index 0 = 9 days ago).
  const [threadDayCountsByAuto, setThreadDayCountsByAuto] = useState<Record<number, number[]> | null>(null)

  useEffect(() => {
    const name = client?.client_name?.trim() ? client.client_name : `Client ${cid}`
    document.title = `${name} — Automation Overview · Arkflow`
  }, [client?.client_name, cid])

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
  // accordion: open team members (worker level)
  const [openTeamIds, setOpenTeamIds] = useState<Set<number>>(() => new Set())
  // accordion: open per-city rows inside a live group
  const [openCityIds, setOpenCityIds] = useState<Set<number>>(() => new Set())
  const [howOpen, setHowOpen] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [openAuditIds, setOpenAuditIds] = useState<Set<string>>(() => new Set())
  // collapsible "Inputs (manual)" cards for built/live rows
  const [openInputsGroupIds, setOpenInputsGroupIds] = useState<Set<string>>(() => new Set())
  const [openInputsCityIds, setOpenInputsCityIds] = useState<Set<number>>(() => new Set())
  const [activeTab, setActiveTab] = useState<'team' | 'opportunities'>('team')
  // ERP Quote Ingestion requests open in a modal, keyed by automation id + title.
  const [erpModal, setErpModal] = useState<{ id: number; title: string } | null>(null)

  const rowEls = useRef(new Map<number, HTMLDivElement>())
  const prevOpenIds = useRef<Set<number>>(new Set())
  const seededBrandOnce = useRef(false)
  // True once load() has fully succeeded at least once. Lets the 30s background
  // refresh swallow transient fetch failures instead of blanking good data.
  const hasLoadedOkRef = useRef(false)
  const openTeamListKeyRef = useRef<string | null>(null)

  useEffect(() => {
    const key = [...teamMembers.map((m) => m.id)].sort((a, b) => a - b).join('\0')
    const idSet = new Set(teamMembers.map((m) => m.id))
    if (openTeamListKeyRef.current !== key) {
      openTeamListKeyRef.current = key
      setOpenTeamIds(new Set(idSet))
      return
    }
    setOpenTeamIds((prev) => {
      let changed = false
      const next = new Set<number>()
      for (const id of prev) {
        if (idSet.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [teamMembers])

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
        totalSavingsHow: '<b>Actual time saved × manual hourly cost</b> (hours saved = runs × min/task ÷ 60). Only live automations with cost fields filled in are counted.',
        totalConversations: 'Customers',
        totalConversationsHow:
          'COUNT(DISTINCT runs.customer) across all runs for every automation on this client (live, testing, discovery). NULL and blank customer values are excluded.',
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
        workerRepliesHow: "Total replies this worker handled in production — the sum of runs across all their automations (discovery excluded).",
        workerPerfHow: 'How much faster than the 5-minute manual baseline this worker responds, as a percentage — higher is better.',
        lastMsg: 'Last Reply',
        deployment: 'Deployed',
        justNow: 'just now',
        quoteRequest: 'Quote Request',
        completed: 'Completed',
        allClients: '← All clients',
        opportunities: 'Opportunities',
        settingsTab: 'Settings',
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
        totalSavingsHow: '<b>Tiempo real ahorrado × coste manual por hora</b> (horas ahorradas = ejecuciones × min/tarea ÷ 60). Solo se cuentan automatizaciones live con los campos de coste completados.',
        totalConversations: 'Clientes',
        totalConversationsHow:
          'COUNT(DISTINCT runs.customer) en todas las ejecuciones de todas las automatizaciones del cliente (live, pruebas, discovery). Se excluyen valores NULL o en blanco en customer.',
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
        workerRepliesHow: 'Total de respuestas gestionadas por este trabajador en producción — la suma de ejecuciones de todas sus automatizaciones (discovery excluido).',
        workerPerfHow: 'Cuánto más rápido responde este trabajador frente a la línea base manual de 5 minutos, en porcentaje — más alto es mejor.',
        lastMsg: 'Última respuesta',
        deployment: 'Desplegado',
        justNow: 'ahora mismo',
        quoteRequest: 'Solicitud de Presupuesto',
        completed: 'Completadas',
        allClients: '← Todos los clientes',
        opportunities: 'Oportunidades',
        settingsTab: 'Configuración',
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
    // Compact axis: 10 very narrow columns. Show just the day-of-month number so
    // labels never collide at any width (the full "DD Mon" form repeated "May"
    // ten times and overflowed/collided in the tight 3-up charts). The chart
    // titles already scope these to the last 10 days.
    return last10DayKeys.map((k) => String(Number(k.split('-')[2] ?? 1)))
  }, [last10DayKeys])

  function relLang(iso: string) {
    if (lang === 'EN') return rel(iso)
    const s = (Date.now() - new Date(iso).getTime()) / 1000
    if (s < 60) return t.justNow
    if (s < 3600) return `hace ${Math.round(s / 60)}m`
    if (s < 86400) return `hace ${Math.round(s / 3600)}h`
    return `hace ${Math.round(s / 86400)}d`
  }

  function earliestCreatedAtIso(rows: Automation[]) {
    let bestIso: string | null = null
    let bestT = Infinity
    for (const r of rows) {
      const iso = r.created_at
      if (iso == null || String(iso).trim() === '') continue
      const t = new Date(iso).getTime()
      if (Number.isNaN(t)) continue
      if (t < bestT) {
        bestT = t
        bestIso = iso
      }
    }
    return bestIso
  }

  function formatDeployedAt(iso: string | null | undefined) {
    if (iso == null || String(iso).trim() === '') return '-'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '-'
    const dd = String(d.getDate()).padStart(2, '0')
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const yyyy = String(d.getFullYear())
    return `${dd}-${mm}-${yyyy}`
  }

  function displayAutomationName(a: Automation) {
    const en = (a.automation_name_en ?? a.automation_name ?? '').toString()
    // ES must use automation_name_local when present (fallbacks keep legacy compatibility)
    const es = (a.automation_name_local ?? a.automation_name_es ?? a.automation_name ?? '').toString()
    const chosen = lang === 'ES' ? es : en
    return chosen.trim() || (a.automation_name ?? '').toString().trim() || '—'
  }

  function isQuoteAutomation(a: Automation) {
    const candidates = [a.automation_name_en, a.automation_name_local, a.automation_name_es, a.automation_name]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase())
      .join(' ')
    return candidates.includes('quote') || candidates.includes('presupuesto')
  }

  // ERP Quote Ingestion automations get an extra request/services table. Matched by
  // name (not id) so it survives the move to multiple cities, in either language.
  function isErpIngestionAutomation(a: Automation) {
    const candidates = [a.automation_name_en, a.automation_name_local, a.automation_name_es, a.automation_name]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase())
      .join(' ')
    return candidates.includes('erp')
  }

  function baseNameForGrouping(
    a: Pick<Automation, 'automation_name' | 'automation_name_en' | 'automation_name_es' | 'automation_name_local'>,
  ) {
    // Grouping should match the language shown to the user.
    return (lang === 'ES'
      ? (a.automation_name_local ?? a.automation_name_es ?? a.automation_name ?? '')
      : (a.automation_name_en ?? a.automation_name ?? '')
    ).toString()
  }

  // ── Data loading ─────────────────────────────────────────────────────────
  async function load(opts?: { background?: boolean }) {
    const background = opts?.background ?? false
    // Foreground loads clear the error optimistically; a background (30s)
    // refresh leaves the screen untouched until we know the outcome.
    if (!background) setError(null)

    // A single `fetch` in the Promise.all below can throw `TypeError: Failed to
    // fetch` on a momentary network blip (wifi drop, wake-from-sleep, VPN).
    // Retry a couple of times with a short backoff before surfacing anything.
    const MAX_ATTEMPTS = 3
    let lastErr: unknown = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (!supabase) {
        setClient(null)
        setAutos([])
        setClientKpis(null)
        setAutoSummaries({})
        setThreadTotalsAll({ total: null, completed: null })
        setThreadTotalsByAuto(null)
        setThreadDayCountsByAuto(null)
        setError('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
        setLoading(false)
        return
      }
      const sb = supabase
      const [cRes, aRes, kpisRes, summariesRes, mcRes, maRes, mRes] = await Promise.all([
        sb.from('clients').select('id,client_name,primary_brand_color,currency,logo_path').eq('id', cid).maybeSingle(),
        sb
          .from('automations')
          .select('*,manual_sample_size,manual_avg_response_time,manual_execution_time_min,manual_hourly_cost,auto_monthly_cost')
          .eq('client_id', cid),
        sb.rpc('get_client_kpis', { p_client_id: cid }),
        sb.rpc('get_automation_summaries', { p_client_id: cid }),
        sb.from('team_members_clients').select('team_member_id').eq('client_id', cid),
        sb.from('team_members_automations').select('team_member_id,automation_id'),
        sb.from('team_members').select('id,slug,initials,name,role_en,role_es,avatar_bg,avatar_color,sort_order').order('sort_order', { ascending: true }),
      ])

      if (aRes.error) throw aRes.error
      if (kpisRes.error) throw kpisRes.error
      if (summariesRes.error) throw summariesRes.error

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
      setClientKpis((kpisRes.data as ClientKpis[] | null)?.[0] ?? null)
      const summaryMap: Record<number, AutomationSummary> = {}
      for (const s of (summariesRes.data as AutomationSummary[] | null) ?? []) {
        summaryMap[s.automation_id] = s
      }
      setAutoSummaries(summaryMap)

      // Team members (DB-driven)
      const memberIds = new Set(((mcRes.data ?? []) as Array<{ team_member_id: number }>).map((r) => r.team_member_id))
      const allMembers = (mRes.data ?? []) as TeamMember[]
      const membersForClient = allMembers.filter((m) => memberIds.has(m.id))
      setTeamMembers(membersForClient)

      // Build member -> automation ids mapping, scoped to automations visible for this client
      const autoIdsForClient = new Set(((aRes.data ?? []) as Automation[]).map((a) => a.id))
      const map: Record<number, number[]> = {}
      for (const row of (maRes.data ?? []) as Array<{ team_member_id: number; automation_id: number }>) {
        if (!memberIds.has(row.team_member_id)) continue
        if (!autoIdsForClient.has(row.automation_id)) continue
        map[row.team_member_id] ??= []
        map[row.team_member_id].push(row.automation_id)
      }
      for (const k of Object.keys(map)) map[Number(k)].sort((x, y) => x - y)
      setMemberAutomationIds(map)

      // Thread stats are aggregated server-side. A previous client-side
      // fetch-and-count was silently capped at PostgREST's 1000-row limit,
      // which truncated totals (e.g. completion read "806/1000").
      try {
        const statsRes = await sb.rpc('get_thread_stats', { p_client_id: cid })
        if (statsRes.error) throw statsRes.error
        const statRows = (statsRes.data ?? []) as Array<{
          automation_id: number
          total: number
          completed: number
          daily_l10d: number[]
        }>

        const totalsByAuto: Record<number, { total: number; completed: number }> = {}
        const dayCountsByAuto: Record<number, number[]> = {}
        let totalAll = 0
        let completedAll = 0

        for (const row of statRows) {
          totalAll += row.total
          completedAll += row.completed
          totalsByAuto[row.automation_id] = { total: row.total, completed: row.completed }
          dayCountsByAuto[row.automation_id] = row.daily_l10d ?? []
        }

        setThreadTotalsAll({ total: totalAll, completed: completedAll })
        setThreadTotalsByAuto(totalsByAuto)
        setThreadDayCountsByAuto(dayCountsByAuto)
      } catch {
        setThreadTotalsAll({ total: null, completed: null })
        setThreadTotalsByAuto(null)
        setThreadDayCountsByAuto(null)
      }
        // Reached here without throwing → the load succeeded.
        setError(null)
        hasLoadedOkRef.current = true
        setLoading(false)
        return
      } catch (e) {
        lastErr = e
        // `TypeError: Failed to fetch` (and friends) are transient network
        // failures, not real errors — retry before giving up.
        const emsg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e)
        const transient =
          e instanceof TypeError ||
          /failed to fetch|networkerror|load failed|fetch failed|network request failed/i.test(emsg)
        if (transient && attempt < MAX_ATTEMPTS) {
          await new Promise((r) => window.setTimeout(r, attempt * 500))
          continue
        }
        break
      }
    }

    // Every attempt failed. Supabase/PostgREST errors are plain objects, not
    // Error instances — pull out their message/code for an actionable message.
    console.error('[dashboard] load failed', lastErr)
    // A transient failure during a background refresh, when there is already
    // data on screen, must NOT blank the dashboard — keep showing what we have.
    if (!(background && hasLoadedOkRef.current)) {
      let msg = 'Failed to load'
      if (lastErr instanceof Error) {
        msg = lastErr.message
      } else if (lastErr && typeof lastErr === 'object') {
        const pe = lastErr as { message?: string; code?: string; details?: string }
        msg = [pe.message, pe.code ? `(${pe.code})` : null, pe.details].filter(Boolean).join(' ') || msg
      }
      setError(msg)
    }
    setLoading(false)
  }

  useEffect(() => {
    void load()
    const interval = window.setInterval(() => void load({ background: true }), 30000)
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
  const byAuto: Record<number, AutoWithSummary> = useMemo(() => {
    const m: Record<number, AutoWithSummary> = {}
    for (const a of autos) m[a.id] = { ...(a as Automation), summary: autoSummaries[a.id] ?? null }
    return m
  }, [autos, autoSummaries])

  const totalThreads = threadTotalsAll.total
  const completedThreads = threadTotalsAll.completed
  const finishedPct = totalThreads && totalThreads > 0 && completedThreads != null ? (completedThreads / totalThreads) * 100 : 0

  const kpis = useMemo(() => {
    const avgRespS = clientKpis?.avg_response_s ?? 0
    const timeSavedMins = clientKpis?.time_saved_mins ?? 0
    const speedPct = avgRespS > 0 ? ((COST_ASSUMPTIONS.MANUAL_RESPONSE_S - avgRespS) / COST_ASSUMPTIONS.MANUAL_RESPONSE_S) * 100 : 0
    return { avgRespS, timeSavedMins, speedPct }
  }, [clientKpis])

  // Per-automation actual savings from backend summary (null when cost fields not configured)
  const autoTotalSavings = (a: AutoWithSummary): number | null => a.summary?.total_savings_eur ?? null

  // Client-level costs saved comes directly from the KPI RPC
  const clientTotalSavings = clientKpis?.costs_saved_eur ?? null

  const discoveryAutos = useMemo(() => {
    const rows = autos.filter((a) => isDiscoveryAutomation(a))
    return rows.sort((a, b) => displayAutomationName(a).localeCompare(displayAutomationName(b), undefined, { sensitivity: 'base' }))
  }, [autos, lang])

  const auditGroups = useMemo(() => {
    const map = new Map<string, Automation[]>()
    for (const a of discoveryAutos) {
      const base = baseNameForGrouping(a)
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

  const liveGroups = useMemo(() => {
    const rows = Object.values(byAuto).filter((a) => !discoveryIds.has(a.id) && !isDiscoveryAutomation(a))
    const groups = new Map<string, AutoWithSummary[]>()
    for (const a of rows) {
      const base = baseNameForGrouping(a)
      const { task } = splitTaskCity(base)
      const bucket = groups.get(task) ?? []
      bucket.push(a)
      groups.set(task, bucket)
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([task, autos]) => ({
        task,
        autos: autos.slice().sort((x, y) => displayAutomationName(x).localeCompare(displayAutomationName(y), undefined, { sensitivity: 'base' })),
      }))
  }, [byAuto, discoveryIds, lang])

  async function saveAutomationCosts(
    automationId: number,
    patch: Partial<Pick<Automation, 'manual_execution_time_min' | 'manual_hourly_cost' | 'auto_monthly_cost' | 'manual_sample_size' | 'manual_avg_response_time'>>,
  ) {
    if (!isInternal) return
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
    if (!isInternal) return
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
              {monthlyRuns != null ? Math.round(monthlyRuns).toLocaleString() : '-'}
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
  function renderSkillRow(a: AutoWithSummary) {
    const sm = a.summary
    const runCount = sm?.run_count ?? 0
    const avgT = sm && sm.avg_response_s > 0 ? sm.avg_response_s.toFixed(0) : '-'
    const last = sm?.last_run_at ? relLang(sm.last_run_at) : '-'
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

    const avgRespA = sm?.avg_response_s ?? 0
    const perfPct = avgRespA > 0 ? ((COST_ASSUMPTIONS.MANUAL_RESPONSE_S - avgRespA) / COST_ASSUMPTIONS.MANUAL_RESPONSE_S) * 100 : 0

    // hourly distribution — dense 24-element arrays from backend
    const hourCounts = sm?.hourly_dist.map((h) => h.c) ?? new Array(24).fill(0)
    const hourAvgs   = sm?.hourly_dist.map((h) => h.s) ?? new Array(24).fill(0)
    const hourTotal  = runCount || 1
    const maxH       = Math.max(...hourCounts, 1)
    const maxHourAvg = Math.max(...hourAvgs, 1)

    // weekday distribution — dense 7-element array from backend (0=Sun)
    const wdCounts = sm?.weekday_dist ?? new Array(7).fill(0)
    const wdOrder  = [1, 2, 3, 4, 5, 6, 0]
    const wdLabels = lang === 'ES' ? ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    const maxWd    = Math.max(...wdOrder.map((d) => wdCounts[d] ?? 0), 1)

    // daily L10D — 10-element array from backend (index 0 = 9 days ago, index 9 = today)
    const emptyDay = { day: '', run_count: 0, avg_resp_s: 0, saved_mins: 0 }
    const daily           = sm?.daily_l10d ?? last10DayKeys.map(() => emptyDay)
    const repliesByDayL10D   = daily.map((d) => d.run_count)
    const avgRespSByDayL10D  = daily.map((d) => d.avg_resp_s)
    const savedMinsByDayL10D = daily.map((d) => d.saved_mins)
    const threadDays = threadDayCountsByAuto?.[a.id]
    const customersByDayL10D = last10DayKeys.map((_, i) => threadDays?.[i] ?? 0)

    const maxRepliesL10D   = Math.max(...repliesByDayL10D, 1)
    const maxDayAvgL10D    = Math.max(...avgRespSByDayL10D, 1)
    const maxSavedMinsL10D = Math.max(...savedMinsByDayL10D, 1)
    const maxCustomersL10D = Math.max(...customersByDayL10D, 1)

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
            <small>{t.deployment}</small>
            <span className="val">{formatDeployedAt(a.created_at)}</span>
          </div>
          <div className="auto-stat">
            <small>{t.msgs}</small>
            <span className="val">{runCount}</span>
          </div>
          {showThreadStats ? (
            <div className="auto-stat">
              <small>{t.totalConversations}</small>
              <span className="val">{totalThreadsAuto != null ? totalThreadsAuto : '-'}</span>
            </div>
          ) : null}
          {showThreadStats ? (
            <div className="auto-stat good">
              <small>{t.completed}</small>
              <span className="val">{totalThreadsAuto != null && totalThreadsAuto > 0 ? `${finishedPctAuto.toFixed(0)}%` : '-'}</span>
            </div>
          ) : null}
          <div className="auto-stat hl">
            <small>{t.avg}</small>
            <span className="val">{avgT}s</span>
          </div>
          <div className="auto-stat good">
            <small>{t.saved}</small>
            <span className="val">{fmtTime(runCount * (coerceFiniteNumber(a.manual_execution_time_min) ?? COST_ASSUMPTIONS.MANUAL_MINS_PER_RUN))}</span>
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
                          <div className={`mini-bar ${cnt === 0 ? 'zero' : ''}`} style={chartBarFillStyle(pct, cnt === 0, brandHex)}>
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
                          <div className={`mini-bar ${!showThreadStats || cnt === 0 ? 'zero' : ''}`} style={chartBarFillStyle(pct, !showThreadStats || cnt === 0, brandHex)}>
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
                          <div className={`hour-bar ${cnt === 0 ? 'zero' : ''}`} style={chartBarFillStyle(pct, cnt === 0, brandHex)}>
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
                          <div className={`mini-bar ${cnt === 0 ? 'zero' : ''}`} style={chartBarFillStyle(pct, cnt === 0, brandHex)}>
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
                          <div className={`mini-bar ${avg === 0 ? 'zero' : ''}`} style={chartBarFillStyle(pct, avg === 0, brandHex)}>
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
                          <div className={`mini-bar ${mins === 0 ? 'zero' : ''}`} style={chartBarFillStyle(pct, mins === 0, brandHex)}>
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
                          <div className={`mini-bar ${avg === 0 ? 'zero' : ''}`} style={chartBarFillStyle(pct, avg === 0, brandHex)}>
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
    // Use weighted average as the input seed (commonFiniteNumberOrNull returns null when cities differ)
    const avgRespCommon = avgRespWeighted != null ? Math.round(avgRespWeighted) : null

    const sampleWeeks = 5
    const weeksPerMonth = 52 / 12 // 4.333...
    // `manual_sample_size` is interpreted as manual audit *message count* (see migrations).
    // For quote-style workflows we estimate "tasks" as request/response *pairs* ≈ messages / 2.
    const samplePairsEstimate = sampleSum > 0 ? sampleSum / 2 : 0
    const monthlyRunsEstimate = samplePairsEstimate > 0 ? (samplePairsEstimate / sampleWeeks) * weeksPerMonth : null

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
                  <small>{lang === 'ES' ? 'Resp. media' : 'Avg resp'}</small>
                  <span className="val">
                    <input
                      className="audit-input"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="00:00:00"
                      defaultValue={avgRespCommon != null ? fmtSecondsHMS(avgRespCommon) : ''}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const v = e.currentTarget.value.trim()
                        if (v === '') {
                          void saveAutomationCostsGroup(ids, { manual_avg_response_time: null })
                          return
                        }
                        const n = parseSecondsHMSOrRaw(v)
                        if (n == null) return
                        void saveAutomationCostsGroup(ids, { manual_avg_response_time: n })
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
                      if (manualMinsCommon == null || manualHourlyCommon == null || monthlyRunsEstimate == null) return '-'
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
                        return <span className="audit-savings-val">-</span>
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

                const base = baseNameForGrouping(a)
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
                        <div className="audit-city-lbl">{lang === 'ES' ? 'T. resp. medio' : 'Avg resp time'}</div>
                        <div className="audit-city-val">
                          <input
                            className="audit-input"
                            type="text"
                            inputMode="numeric"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="00:00:00"
                            defaultValue={manualAvgResp != null ? fmtSecondsHMS(manualAvgResp) : ''}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={(e) => {
                              const v = e.currentTarget.value.trim()
                              if (v === '') {
                                void saveAutomationCosts(a.id, { manual_avg_response_time: null })
                                return
                              }
                              const n = parseSecondsHMSOrRaw(v)
                              if (n == null) return
                              void saveAutomationCosts(a.id, { manual_avg_response_time: n })
                            }}
                          />
                        </div>
                      </div>
                      <div className="audit-city-metric">
                        <div className="audit-city-lbl">{lang === 'ES' ? 'Hilos' : 'Threads'}</div>
                        <div className="audit-city-val">{totalThreads != null ? Math.round(totalThreads) : '-'}</div>
                      </div>
                      <div className="audit-city-metric">
                        <div className="audit-city-lbl">{lang === 'ES' ? 'Completadas' : 'Completed'}</div>
                        <div className="audit-city-val">{completionPct != null ? `${completionPct.toFixed(0)}%` : '-'}</div>
                      </div>
                      <div className="audit-city-metric">
                        <div className="audit-city-lbl">{lang === 'ES' ? 'Hanging' : 'Hanging'}</div>
                        <div className="audit-city-val">{hangingPct != null ? `${hangingPct.toFixed(0)}%` : '-'}</div>
                      </div>
                      <div className="audit-city-metric">
                        <div className="audit-city-lbl">{lang === 'ES' ? 'Tiempo para cerrar' : 'Avg time to close'}</div>
                        <div className="audit-city-val">{avgTimeToCompleteS != null ? fmtDurationS(avgTimeToCompleteS) : '-'}</div>
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
  function renderLiveGroupRow(groupKey: string, task: string, groupAutos: AutoWithSummary[]) {
    const ids = groupAutos.map((a) => a.id)
    const allTypeIds = Object.values(byAuto)
      .filter((a) => !isDiscoveryAutomation(a))
      .filter((a) => {
        const base = baseNameForGrouping(a)
        return splitTaskCity(base).task === task
      })
      .map((a) => a.id)
    const totalRuns = groupAutos.reduce((s, a) => s + (a.summary?.run_count ?? 0), 0)
    const sumRespS = groupAutos.reduce((s, a) => s + (a.summary?.avg_response_s ?? 0) * (a.summary?.run_count ?? 0), 0)
    const avgRespS = totalRuns > 0 ? sumRespS / totalRuns : 0
    const timeSavedMins = groupAutos.reduce((s, a) => s + (a.summary?.run_count ?? 0) * (coerceFiniteNumber(a.manual_execution_time_min) ?? COST_ASSUMPTIONS.MANUAL_MINS_PER_RUN), 0)
    const lastCreatedAt = groupAutos.reduce((latest, a) => {
      const t = a.summary?.last_run_at
      if (!t) return latest
      return !latest || t > latest ? t : latest
    }, null as string | null)

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
    const groupFirstRunAt = groupAutos.reduce((oldest, a) => {
      const f = a.summary?.first_run_at
      if (!f) return oldest
      return !oldest || f < oldest ? f : oldest
    }, null as string | null)
    const actualGroupMonthsActive = groupFirstRunAt != null
      ? Math.max((Date.now() - new Date(groupFirstRunAt).getTime()) / (1000 * 60 * 60 * 24 * 30.44), 1 / 30.44)
      : null
    const actualGroupRunsPerMonth = actualGroupMonthsActive != null ? totalRuns / actualGroupMonthsActive : null
    const manualMonthly = manualPerRun != null && actualGroupRunsPerMonth != null ? manualPerRun * actualGroupRunsPerMonth : null

    let groupTotalSavings: number | null = null
    for (const a of groupAutos) {
      const s = autoTotalSavings(a)
      if (s != null) groupTotalSavings = (groupTotalSavings ?? 0) + s
    }

    const isOpen = openLiveGroupIds.has(groupKey)
    const canEditCommon = groupAutos.length > 0
    const inputsOpen = openInputsGroupIds.has(groupKey)
    // ERP groups render the per-city breakdown (with its charts) even with one city,
    // and add a request/services table inside each city.
    const isErpGroup = groupAutos.some(isErpIngestionAutomation)

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
            <small>{t.deployment}</small>
            <span className="val">{formatDeployedAt(earliestCreatedAtIso(groupAutos))}</span>
          </div>
          <div className="auto-stat">
            <small>{t.msgs}</small>
            <span className="val">{totalRuns}</span>
          </div>
          <div className="auto-stat hl">
            <small>{t.avg}</small>
            <span className="val">{avgRespS > 0 ? `${avgRespS.toFixed(0)}s` : '-'}</span>
          </div>
          <div className="auto-stat good">
            <small>{t.saved}</small>
            <span className="val">{fmtTime(timeSavedMins)}</span>
          </div>
          <div className="auto-stat good">
            <small>{lang === 'ES' ? 'Costes ahorrados' : 'Costs saved'}</small>
            <span className="val">{groupTotalSavings != null ? fmtC(groupTotalSavings) : '-'}</span>
          </div>
          <div className="auto-stat">
            <small>{t.lastMsg}</small>
            <span className="val">{lastCreatedAt ? relLang(lastCreatedAt) : '-'}</span>
          </div>
          {chevronSvg()}
        </div>

        <div className="auto-detail">
          {/* Cost inputs (built/live) */}
          <div className={`detail-strip inputs-card ${inputsOpen ? 'open' : ''}`} style={{ marginBottom: 12 }}>
            <button
              type="button"
              className="strip-head strip-head-btn"
              style={{ backgroundColor: brandBg, color: 'var(--text2)' }}
              onClick={(e) => {
                e.stopPropagation()
                setOpenInputsGroupIds((prev) => {
                  const next = new Set(prev)
                  if (next.has(groupKey)) next.delete(groupKey)
                  else next.add(groupKey)
                  return next
                })
              }}
            >
              <span>{lang === 'ES' ? 'Inputs (manual)' : 'Inputs (manual)'}</span>
              <span className="inputs-chevron" aria-hidden="true">{chevronSvg()}</span>
            </button>
            <div className="inputs-body">
              <div className="strip-nums three-wide">
              <div className="strip-num">
                <div className="sn-lbl">{lang === 'ES' ? 'Min/tarea' : 'Min/task'}</div>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  defaultValue={manualMinsCommon ?? (groupAutos.length === 1 ? (coerceFiniteNumber(groupAutos[0]?.manual_execution_time_min) ?? '') : '')}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    if (!canEditCommon) return
                    const v = e.currentTarget.value.trim()
                    const n = v === '' ? null : Number(v)
                    const next = Number.isFinite(n as number) ? (n as number) : null
                    void saveAutomationCostsGroup(allTypeIds.length > 0 ? allTypeIds : ids, { manual_execution_time_min: next })
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
                <div className="sn-lbl">{lang === 'ES' ? `${currencySym}/hora` : `${currencySym}/hour`}</div>
                <input
                  type="number"
                  min={0}
                  step={1}
                  defaultValue={manualHourlyCommon ?? (groupAutos.length === 1 ? (coerceFiniteNumber(groupAutos[0]?.manual_hourly_cost) ?? '') : '')}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    if (!canEditCommon) return
                    const v = e.currentTarget.value.trim()
                    const n = v === '' ? null : Number(v)
                    const next = Number.isFinite(n as number) ? (n as number) : null
                    void saveAutomationCostsGroup(allTypeIds.length > 0 ? allTypeIds : ids, { manual_hourly_cost: next })
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
                <div className="sn-lbl">{lang === 'ES' ? 'Coste manual / tarea' : 'Manual cost / task'}</div>
                <div className="sn-val">
                  {(() => {
                    const mins =
                      manualMinsCommon ?? (groupAutos.length === 1 ? coerceFiniteNumber(groupAutos[0]?.manual_execution_time_min) : null)
                    const hourly =
                      manualHourlyCommon ?? (groupAutos.length === 1 ? coerceFiniteNumber(groupAutos[0]?.manual_hourly_cost) : null)
                    if (mins == null || hourly == null) return '-'
                    return fmtC((hourly * mins) / 60)
                  })()}
                </div>
              </div>
              </div>
            </div>
          </div>

          {/* Per-city breakdown — accordion rows */}
          {(groupAutos.length > 1 || isErpGroup) && (
            <div className="city-rows">
              {groupAutos.map((a) => {
                const base = baseNameForGrouping(a)
                const { city } = splitTaskCity(base)
                const citySm = a.summary
                const cityRuns = citySm?.run_count ?? 0
                const cityAvg = citySm && citySm.avg_response_s > 0 ? citySm.avg_response_s : null
                const citySavings = autoTotalSavings(a)
                const isCityOpen = openCityIds.has(a.id)

                const emptyDayCity = { day: '', run_count: 0, avg_resp_s: 0, saved_mins: 0 }
                const cityDaily = citySm?.daily_l10d ?? last10DayKeys.map(() => emptyDayCity)
                const cityRepliesByDayL10D   = cityDaily.map((d) => d.run_count)
                const cityAvgRespByDayL10D   = cityDaily.map((d) => d.avg_resp_s)
                const citySavedMinsByDayL10D = cityDaily.map((d) => d.saved_mins)

                const maxCityRepliesL10D   = Math.max(...cityRepliesByDayL10D, 1)
                const maxCityAvgRespL10D   = Math.max(...cityAvgRespByDayL10D, 1)
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
                        <small>{t.deployment}</small>
                        <span className="val">{formatDeployedAt(a.created_at)}</span>
                      </div>
                      <div className="auto-stat">
                        <small>{t.msgs}</small>
                        <span className="val">{cityRuns > 0 ? cityRuns : '-'}</span>
                      </div>
                      <div className="auto-stat hl">
                        <small>{t.avg}</small>
                        <span className="val">{cityAvg != null ? `${cityAvg.toFixed(0)}s` : '-'}</span>
                      </div>
                      <div className="auto-stat good">
                        <small>{t.saved}</small>
                        <span className="val">{cityRuns > 0 ? fmtTime(cityRuns * (coerceFiniteNumber(a.manual_execution_time_min) ?? COST_ASSUMPTIONS.MANUAL_MINS_PER_RUN)) : '-'}</span>
                      </div>
                      <div className="auto-stat good">
                        <small>{lang === 'ES' ? 'Costes ahorra.' : 'Costs saved'}</small>
                        <span className="val">{citySavings != null ? fmtC(citySavings) : '-'}</span>
                      </div>
                      <div className="auto-stat">
                        <small>{t.lastMsg}</small>
                        <span className="val">{citySm?.last_run_at ? relLang(citySm.last_run_at) : '-'}</span>
                      </div>
                      {chevronSvg()}
                    </div>

                    <div className="city-row-detail">
                      {(() => {
                        const cityInputsOpen = openInputsCityIds.has(a.id)
                        return (
                          <div className={`detail-strip inputs-card ${cityInputsOpen ? 'open' : ''}`} style={{ marginBottom: 12 }}>
                            <button
                              type="button"
                              className="strip-head strip-head-btn"
                              style={{ backgroundColor: brandBg, color: 'var(--text2)' }}
                              onClick={(e) => {
                                e.stopPropagation()
                                setOpenInputsCityIds((prev) => {
                                  const next = new Set(prev)
                                  if (next.has(a.id)) next.delete(a.id)
                                  else next.add(a.id)
                                  return next
                                })
                              }}
                            >
                              <span>{lang === 'ES' ? 'Inputs (manual)' : 'Inputs (manual)'}</span>
                              <span className="inputs-chevron" aria-hidden="true">{chevronSvg()}</span>
                            </button>
                            <div className="inputs-body">
                              <div className="strip-nums three-wide">
                          <div className="strip-num">
                            <div className="sn-lbl">{lang === 'ES' ? 'Min/tarea' : 'Min/task'}</div>
                            <input
                              type="number"
                              min={0}
                              step={0.5}
                              defaultValue={coerceFiniteNumber(a.manual_execution_time_min) ?? ''}
                              onClick={(e) => e.stopPropagation()}
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
                          </div>
                          <div className="strip-num">
                            <div className="sn-lbl">{lang === 'ES' ? `${currencySym}/hora` : `${currencySym}/hour`}</div>
                            <input
                              type="number"
                              min={0}
                              step={1}
                              defaultValue={coerceFiniteNumber(a.manual_hourly_cost) ?? ''}
                              onClick={(e) => e.stopPropagation()}
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
                            <div className="sn-lbl">{lang === 'ES' ? 'Coste manual / tarea' : 'Manual cost / task'}</div>
                            <div className="sn-val">
                              {(() => {
                                const mins = coerceFiniteNumber(a.manual_execution_time_min)
                                const hourly = coerceFiniteNumber(a.manual_hourly_cost)
                                if (mins == null || hourly == null) return '-'
                                return fmtC((hourly * mins) / 60)
                              })()}
                            </div>
                          </div>
                              </div>
                            </div>
                          </div>
                        )
                      })()}

                      <div className="strip-charts city-charts">
                        <div className="strip-chart">
                          <div className="mini-chart-title">{t.repliesL10D}</div>
                          <div className="mini-bars">
                            {cityRepliesByDayL10D.map((cnt, i) => {
                              const pct = (cnt / maxCityRepliesL10D) * 100
                              return (
                                <div className="mini-bar-g" key={last10DayKeys[i]}>
                                  <div className="mini-bar-track">
                                    <div className={`mini-bar ${cnt === 0 ? 'zero' : ''}`} style={chartBarFillStyle(pct, cnt === 0, brandHex)}>
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
                                    <div className={`mini-bar ${mins === 0 ? 'zero' : ''}`} style={chartBarFillStyle(pct, mins === 0, brandHex)}>
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
                                    <div className={`mini-bar ${avg === 0 ? 'zero' : ''}`} style={chartBarFillStyle(pct, avg === 0, brandHex)}>
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

                      {/* ERP request/services — opens in a modal. */}
                      {isErpIngestionAutomation(a) && (
                        <button
                          type="button"
                          className="erp-open-btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            setErpModal({ id: a.id, title: displayAutomationName(a) })
                          }}
                        >
                          {lang === 'ES' ? 'Ver solicitudes de presupuesto' : 'View quote requests'}
                        </button>
                      )}
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

  // ── Team member renderer (DB-driven) ─────────────────────────────────────
  function renderTeamMember(member: TeamMember) {
    const ids = memberAutomationIds[member.id] ?? []
    const memberAutos = (ids.map((id) => byAuto[id]).filter(Boolean) as AutoWithSummary[]).filter((a) => !isDiscoveryAutomation(a))
    const totalReplies = memberAutos.reduce((s, a) => s + (a.summary?.run_count ?? 0), 0)
    const sumRespS = memberAutos.reduce((s, a) => s + (a.summary?.avg_response_s ?? 0) * (a.summary?.run_count ?? 0), 0)
    const avgRespS = totalReplies > 0 ? sumRespS / totalReplies : 0
    const timeSavedMins = memberAutos.reduce((s, a) => s + (a.summary?.run_count ?? 0) * (coerceFiniteNumber(a.manual_execution_time_min) ?? COST_ASSUMPTIONS.MANUAL_MINS_PER_RUN), 0)
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

    const statusClass = memberAutos.length === 0 ? 'offline' : hasLive ? 'live' : hasTesting ? 'testing' : 'offline'
    const statusLabel =
      memberAutos.length === 0
        ? t.inactiveStatus
        : hasLive
          ? t.activeStatus
          : hasTesting
            ? t.testingStatus
            : t.inactiveStatus

    const teamOpen = openTeamIds.has(member.id)

    return (
      <div key={member.id} className={`team-member ${teamOpen ? 'open' : ''}`}>
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
            style={{ background: member.avatar_bg ?? 'var(--brand-bg)', color: member.avatar_color ?? 'var(--brand)' }}
          >
            {(member.initials ?? '').slice(0, 3)}
          </div>
          <div className="team-member-info">
            <div className="team-member-name">
              {member.name}
              <span className={`row-live ${statusClass}`}>
                <span className={`live-dot ${statusClass}`}></span>
                {statusLabel}
              </span>
            </div>
            <div className="team-member-role">{lang === 'ES' ? member.role_es : member.role_en}</div>
          </div>

          <Tooltip asChild label={t.workerRepliesHow}>
            <div className="team-stat">
              <span className="ts-val">{totalReplies > 0 ? totalReplies : <span className="dim">-</span>}</span>
              <small>{t.msgs}</small>
            </div>
          </Tooltip>
          <Tooltip asChild label={t.workerPerfHow}>
            <div className="team-stat">
              <span className={`ts-val ${totalReplies > 0 && perfPct > 0 ? 'green' : 'dim'}`}>
                {totalReplies > 0 ? `${perfPct.toFixed(0)}%` : '-'}
              </span>
              <small>{t.perf}</small>
            </div>
          </Tooltip>
          <Tooltip asChild label={t.avgRespHow}>
            <div className="team-stat">
              <span className="ts-val">{avgRespS > 0 ? `${avgRespS.toFixed(0)}s` : <span className="dim">-</span>}</span>
              <small>{t.avg}</small>
            </div>
          </Tooltip>
          <Tooltip asChild label={t.timeSavedHow}>
            <div className="team-stat">
              <span className={`ts-val ${totalReplies > 0 ? 'green' : 'dim'}`}>
                {totalReplies > 0 ? fmtTime(timeSavedMins) : '-'}
              </span>
              <small>{t.saved}</small>
            </div>
          </Tooltip>
          <Tooltip asChild label={t.totalSavingsHow.replace(/<[^>]*>/g, '')}>
            <div className="team-stat">
              <span className={`ts-val ${memberSavings != null && memberSavings > 0 ? 'green' : 'dim'}`}>
                {memberSavings != null ? fmtC(memberSavings) : '-'}
              </span>
              <small>{lang === 'ES' ? 'Costes ahorrados' : 'Costs saved'}</small>
            </div>
          </Tooltip>

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
                  const groups = new Map<string, AutoWithSummary[]>()
                  for (const a of memberAutos) {
                    const base = baseNameForGrouping(a)
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
  const [logoUploading, setLogoUploading] = useState(false)
  const logoFileRef = useRef<HTMLInputElement | null>(null)

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
    if (!isInternal) return
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
    if (!isInternal) return
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
      className="page dashboard-page"
      style={{
        // Set all brand/green vars directly so .kpi-val.green, .auto-stat.good etc.
        // always pick up the live brand color without relying on :root indirection.
        ['--brand' as never]: brandHex,
        ['--brand-bg' as never]: brandBg,
        ['--green' as never]: brandHex,
        ['--green-bg' as never]: brandBg,
        ['--chart-bar' as never]: brandHex,
      }}
    >
      <header className="header">
        <div className="wrap">
          <a className="logo" href="#">
            <img src="/logos/arkflow-logo.svg" alt="Arkflow" className="logo-img" />
          </a>
          <div className="header-tabs">
            <button type="button" className={`hdr-tab ${activeTab === 'team' ? 'active' : ''}`} onClick={() => setActiveTab('team')}>{t.yourTeam}</button>
            <button type="button" className={`hdr-tab ${activeTab === 'opportunities' ? 'active' : ''}`} onClick={() => setActiveTab('opportunities')}>{t.opportunities}</button>
          </div>
          <div className="header-r">
            <div className="header-ctls">
              {isInternal && <select
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
              </select>}

              {isInternal && <div className="brand-picker" ref={brandPickerWrapRef}>
                <Tooltip asChild label={lang === 'ES' ? 'Color de marca' : 'Brand color'}>
                  <button
                    type="button"
                    className="hdr-ctl hdr-btn brand-btn"
                    aria-haspopup="dialog"
                    aria-expanded={brandPickerOpen}
                    onClick={() => setBrandPickerOpen((v) => !v)}
                  >
                    <span className="brand-swatch" style={{ background: brandHex }} aria-hidden="true" />
                  </button>
                </Tooltip>

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

                    <div className="brand-pop-row">
                      <label className="brand-pop-lbl">{lang === 'ES' ? 'Logo' : 'Logo'}</label>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          ref={logoFileRef}
                          type="file"
                          accept="image/*"
                          style={{ display: 'none' }}
                          onChange={(e) => {
                            const f = e.currentTarget.files?.[0] ?? null
                            e.currentTarget.value = ''
                            if (!f) return
                            void (async () => {
                              try {
                                setLogoUploading(true)
                                const newPath = await uploadClientLogo({ clientId: cid, file: f })
                                setClient((prev) => (prev ? { ...prev, logo_path: newPath } : { id: cid, logo_path: newPath }))
                              } finally {
                                setLogoUploading(false)
                              }
                            })()
                          }}
                        />
                        <button
                          type="button"
                          className="hdr-ctl hdr-btn"
                          disabled={logoUploading}
                          onClick={() => logoFileRef.current?.click()}
                        >
                          {logoUploading
                            ? (lang === 'ES' ? 'Subiendo…' : 'Uploading…')
                            : (lang === 'ES' ? 'Subir logo' : 'Upload logo')}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>}

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
              <ChangePassword />
              <button
                onClick={() => void signOut()}
                className="hdr-ctl hdr-btn"
              >
                {t.signOut}
              </button>

              {isInternal && <a className="hdr-ctl hdr-btn" href="/admin" style={{ textDecoration: 'none' }}>
                {lang === 'ES' ? 'Admin' : 'Admin'}
              </a>}

              {canManageMembers && <a className="hdr-ctl hdr-btn" href="/manage" style={{ textDecoration: 'none' }}>
                {lang === 'ES' ? 'Gestionar acceso' : 'Manage access'}
              </a>}
            </div>
          </div>
        </div>
      </header>

      <section className="topbar">
        <div className="wrap">
          {canSwitchClients && (
            <button className="back-link" onClick={() => navigate('/')}>
              {t.allClients}
            </button>
          )}
          <div className="topbar-label">{t.clientDashboard}</div>
          <h1>
            <img
              src={clientLogoUrl(client?.logo_path)}
              alt={client?.client_name?.trim() ? client.client_name : 'Client'}
              className="client-logo"
            />
            {client?.client_name?.trim() ? client.client_name : `Client ${cid}`}
          </h1>

          {activeTab === 'opportunities' && (
            <div className="opp-intro">
              <p>
                {(() => {
                const nTasks = auditGroups.length
                const uniqueCities = new Set(
                  auditGroups.flatMap((g) =>
                    g.rows.map((a) => splitTaskCity(baseNameForGrouping(a)).city).filter(Boolean)
                  )
                )
                const nLocs = uniqueCities.size || auditGroups.reduce((s, g) => s + g.rows.length, 0)
                return lang === 'ES'
                  ? `${nTasks} oportunidad${nTasks !== 1 ? 'es' : ''} × ${nLocs} ubicacion${nLocs !== 1 ? 'es' : ''}. Los datos de benchmark se basan en una muestra de 5 semanas de operativa manual. El potencial de ahorro mensual se calcula como: ejecuciones/mes estimadas × coste manual por tarea − coste mensual de la automatización.`
                  : `${nTasks} opportunit${nTasks !== 1 ? 'ies' : 'y'} × ${nLocs} location${nLocs !== 1 ? 's' : ''}. Benchmark data is based on a 5-week sample of manual operations. Monthly savings potential = estimated runs/month × manual cost per task − automation monthly cost.`
              })()}
              </p>
            </div>
          )}

          {activeTab === 'team' && <div className="kpis">
            <Tooltip asChild label={t.avgRespHow}>
              <div className="kpi">
                <div className="kpi-val green" id="kAvgResp">
                  {kpis.avgRespS > 0 ? `${kpis.avgRespS.toFixed(0)}s` : '-'}
                </div>
                <div className="kpi-lbl">{t.avgResponseTime}</div>
              </div>
            </Tooltip>
            <Tooltip asChild label={t.timeSavedHow}>
              <div className="kpi">
                <div className="kpi-val green" id="kTimeSaved">
                  {fmtTime(kpis.timeSavedMins)}
                </div>
                <div className="kpi-lbl">{t.timeSaved}</div>
              </div>
            </Tooltip>
            <Tooltip asChild label={t.totalSavingsHow.replace(/<[^>]*>/g, '')}>
              <div className="kpi">
                <div className={`kpi-val ${clientTotalSavings != null && clientTotalSavings > 0 ? 'green' : ''}`} id="kSavings">
                  {clientTotalSavings != null ? fmtC(clientTotalSavings) : '-'}
                </div>
                <div className="kpi-lbl">{lang === 'ES' ? 'Costes ahorrados' : 'Costs saved'}</div>
              </div>
            </Tooltip>
            <Tooltip asChild label={t.totalConversationsHow}>
              <div className="kpi highlight">
                <div className="kpi-val" id="kTotalConvos">
                  {clientKpis != null ? clientKpis.total_customers : '-'}
                </div>
                <div className="kpi-lbl">{t.totalConversations}</div>
              </div>
            </Tooltip>
            <Tooltip asChild label={t.finishedHow}>
              <div className="kpi highlight">
                <div className="kpi-val" id="kFinishedPct">
                  {totalThreads != null && totalThreads > 0
                    ? `${finishedPct.toFixed(0)}% (${completedThreads ?? 0}/${totalThreads})`
                    : '-'}
                </div>
                <div className="kpi-lbl">{t.completed}</div>
              </div>
            </Tooltip>
          </div>}

          {activeTab === 'team' && brandSaveError ? (
            <div className="error-msg" style={{ marginTop: 12 }}>
              Failed to save brand color to DB. {brandSaveError}
            </div>
          ) : null}

          {activeTab === 'team' && <>
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
          </>}
        </div>
      </section>

      <main className="section">
        <div className="wrap">
          {error ? (
            <div className="error-msg">Failed to load. {error}</div>
          ) : !loading && autos.length === 0 ? (
            <div className="error-msg" style={{ background: 'var(--red-bg)', color: 'var(--red)' }}>
              No rows are visible from Supabase. This usually means Row Level Security is enabled without a SELECT policy for the current access mode (anon).
            </div>
          ) : activeTab === 'opportunities' ? (
            <div className="team-list">
              {discoveryAutos.length === 0 && !loading ? (
                <div className="tab-empty-state">
                  <div className="tab-empty-icon">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                  </div>
                  <div className="tab-empty-title">{lang === 'EN' ? 'No opportunities yet' : 'Sin oportunidades aún'}</div>
                  <div className="tab-empty-desc">{lang === 'EN' ? 'Automations in discovery status will appear here.' : 'Las automatizaciones en estado discovery aparecerán aquí.'}</div>
                </div>
              ) : (
                <>
                  <div className="section-head">
                    <div className="section-label">{t.opportunities}</div>
                    <div className="section-count">
                      {auditGroups.length} {lang === 'EN' ? 'opportunities' : 'oportunidades'} · {discoveryAutos.length} {lang === 'EN' ? 'automations' : 'automatizaciones'}
                    </div>
                  </div>
                  <div className="auto-list">
                    {auditGroups.map((g) => renderAuditGroupRow(g))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="team-list">
              <div className="section-head">
                <div className="section-label">{t.yourTeam}</div>
                <div className="section-count">
                  {teamMembers.length} {t.members}
                </div>
              </div>

              {loading ? (
                <div className="skills-empty">
                  <div className="spinner" style={{ margin: '0 auto 8px' }}></div>
                </div>
              ) : teamMembers.length === 0 ? (
                <div className="tab-empty-state">
                  <div className="tab-empty-icon">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                  </div>
                  <div className="tab-empty-title">{lang === 'EN' ? 'No team members assigned' : 'Sin miembros asignados'}</div>
                  <div className="tab-empty-desc">{lang === 'EN' ? 'Assign team members to this client to see the team view.' : 'Asigna miembros a este cliente para ver el equipo.'}</div>
                </div>
              ) : (
                teamMembers.map((m) => renderTeamMember(m))
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

      {erpModal && (
        <ErpIngestionModal
          automationId={erpModal.id}
          title={erpModal.title}
          lang={lang}
          onClose={() => setErpModal(null)}
        />
      )}
    </div>
  )
}
