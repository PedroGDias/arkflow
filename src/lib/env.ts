type AuthMode = 'supabase' | 'mock'

function opt(name: string): string | undefined {
  const v = import.meta.env[name] as string | undefined
  return v && v.length ? v : undefined
}

function req(name: string): string {
  const v = opt(name)
  if (!v) throw new Error(`Missing environment variable: ${name}`)
  return v
}

export const env = {
  authMode: ((opt('VITE_AUTH_MODE') ?? 'mock') as AuthMode),
  supabaseUrl: opt('VITE_SUPABASE_URL'),
  supabaseAnonKey: opt('VITE_SUPABASE_ANON_KEY'),
  clientId: Number(import.meta.env.VITE_CLIENT_ID ?? '1'),
  oauthRedirectTo: (import.meta.env.VITE_OAUTH_REDIRECT_TO as string | undefined) ?? undefined,
}

