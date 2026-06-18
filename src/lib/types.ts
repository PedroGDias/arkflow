export type Automation = {
  id: number
  client_id: number
  // Backwards-compatible: older rows may still have `automation_name`.
  // New schema: separate EN and local (ES) display names.
  automation_name?: string
  automation_name_en?: string
  automation_name_es?: string
  automation_name_local?: string
  status?: 'Live' | 'Testing' | string | null
  manual_sample_size?: number | null
  manual_avg_response_time?: number | null
  manual_execution_time_min?: number | null
  manual_hourly_cost?: number | null
  auto_monthly_cost?: number | null
  /** Automation row insertion time (Postgres created_at); used as deployment date in UI. */
  created_at?: string | null
}

export type Run = {
  id: number
  automation_id: number
  created_at: string
  status: string | null
  response_time: number | null
  customer?: string | null
}

export type Client = {
  id: number
  client_name?: string | null
  primary_brand_color?: string | null
  currency?: string | null
  logo_path?: string | null
}

export type TeamMember = {
  id: number
  slug: string
  initials: string
  name: string
  role_en: string
  role_es: string
  avatar_bg?: string | null
  avatar_color?: string | null
  sort_order?: number | null
}

// ── ERP Quote Ingestion (automation 21, Autocares Julia) ───────────────────────

export type ErpIngestionEmail = {
  id: number
  created_at: string
  automation_id: number
  email_id: string | null
  email_subject: string | null
  contact_name: string | null
  contact_email: string | null
  contact_phone: string | null
}

export type ErpIngestionService = {
  id: number
  created_at: string
  email_row_id: number
  origin: string | null
  destination: string | null
  passengers: string | null
  departure_datetime: string | null
  arrival_datetime: string | null
  itinerary: string | null
}

export type ErpIngestionEmailWithServices = ErpIngestionEmail & {
  services: ErpIngestionService[]
}

// ── RPC return types ──────────────────────────────────────────────────────────

export type ClientKpis = {
  avg_response_s: number
  time_saved_mins: number
  costs_saved_eur: number | null  // null when no automation has cost data configured
  total_customers: number
}

export type DailyBucket = {
  day: string        // "YYYY-MM-DD"
  run_count: number
  avg_resp_s: number
  saved_mins: number
}

export type HourlyBucket = {
  c: number   // run count for this hour
  s: number   // avg response time (seconds)
}

export type AutomationSummary = {
  automation_id: number
  run_count: number
  avg_response_s: number
  last_run_at: string | null
  first_run_at: string | null
  total_savings_eur: number | null  // null when cost fields not configured
  daily_l10d: DailyBucket[]         // 10 elements, index 0 = 9 days ago, index 9 = today
  hourly_dist: HourlyBucket[]       // 24 elements, indexed by hour (0–23)
  weekday_dist: number[]            // 7 elements, indexed by weekday (0=Sun … 6=Sat)
}

