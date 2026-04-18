export type Automation = {
  id: number
  client_id: number
  // Backwards-compatible: older rows may still have `automation_name`.
  // New schema: separate EN and local (ES) display names.
  automation_name?: string
  automation_name_en?: string
  automation_name_es?: string
  automation_name_local?: string
}

export type Run = {
  id: number
  automation_id: number
  created_at: string
  status: string | null
  response_time: number | null
}

