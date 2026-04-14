export const COST_ASSUMPTIONS = {
  // Manual: FTE at €1500/mo, 5 min per run
  FTE_EUR: 1500,
  WORK_MINS: 22 * 8 * 60, // 10,560 min/month
  MANUAL_MINS_PER_RUN: 5,

  // Manual response time baseline: 1.56 hours
  MANUAL_RESPONSE_S: 1.56 * 60 * 60, // 5616 seconds

  // Auto: GPT-4.5 @ $75/M input · $150/M output, 1300 tokens/run (≈70/30 split), 1 USD ≈ 0.92 EUR
  TOKENS: 1300,
  IN_RATIO: 0.7,
  IN_USD_PER_M: 75,
  OUT_USD_PER_M: 150,
  USD_EUR: 0.92,
} as const

export function manualCostPerRunEur() {
  const { FTE_EUR, WORK_MINS, MANUAL_MINS_PER_RUN } = COST_ASSUMPTIONS
  return (FTE_EUR / WORK_MINS) * MANUAL_MINS_PER_RUN
}

export function autoCostPerRunEur() {
  const { TOKENS, IN_RATIO, IN_USD_PER_M, OUT_USD_PER_M, USD_EUR } = COST_ASSUMPTIONS
  const inTokens = Math.round(TOKENS * IN_RATIO)
  const outTokens = TOKENS - inTokens
  return ((inTokens * IN_USD_PER_M + outTokens * OUT_USD_PER_M) / 1e6) * USD_EUR
}

export function fmtK(n: number) {
  if (!Number.isFinite(n)) return '–'
  return n >= 1000 ? `€${(n / 1000).toFixed(1)}k` : `€${Math.round(n)}`
}

export function fmtTime(mins: number) {
  if (!Number.isFinite(mins)) return '–'
  if (mins < 60) return `${Math.round(mins)}m`
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  return `${h}h${m > 0 ? `${m}m` : ''}`
}

export function rel(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

