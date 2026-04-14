export const ALLOWED_EMAIL_DOMAIN = 'arkflow.ai'

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const at = email.lastIndexOf('@')
  if (at === -1) return false
  const domain = email.slice(at + 1).toLowerCase()
  return domain === ALLOWED_EMAIL_DOMAIN
}

