export type Automation = {
  id: number
  client_id: number
  automation_name: string
}

export type Run = {
  id: number
  automation_id: number
  created_at: string
  status: string | null
  response_time: number | null
}

