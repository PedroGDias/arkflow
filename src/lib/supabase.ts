import { createClient } from '@supabase/supabase-js'
import { env } from './env'

export const supabase =
  env.supabaseUrl && env.supabaseAnonKey
    ? createClient(env.supabaseUrl, env.supabaseAnonKey, {
        auth:
          env.authMode === 'supabase'
            ? {
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: true,
              }
            : {
                // mock mode: we still use Supabase for data, but not for auth/session handling
                persistSession: false,
                autoRefreshToken: false,
                detectSessionInUrl: false,
              },
      })
    : null

