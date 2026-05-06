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

