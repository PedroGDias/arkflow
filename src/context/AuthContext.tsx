import type { Session } from '@supabase/supabase-js'
import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react'
import { isAllowedEmail } from '../lib/authz'
import { env } from '../lib/env'
import { supabase } from '../lib/supabase'

type MockSession = { user: { email: string } }

type AuthState = {
  session: (Session | MockSession) | null
  initializing: boolean
  signInWithGoogle: () => Promise<void>
  signOut: () => Promise<void>
  accounts: string[]
}

const Ctx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<(Session | MockSession) | null>(null)
  const [initializing, setInitializing] = useState(true)

  useEffect(() => {
    if (env.authMode === 'mock') {
      const email = window.localStorage.getItem('mock_email')
      setSession(email ? ({ user: { email } } satisfies MockSession) : null)
      setInitializing(false)
      return
    }

    if (!supabase) {
      setSession(null)
      setInitializing(false)
      return
    }
    const sb = supabase

    let mounted = true
    sb.auth
      .getSession()
      .then(({ data }) => {
        if (!mounted) return
        if (data.session && !isAllowedEmail(data.session.user.email)) {
          void sb.auth.signOut()
          setSession(null)
          setInitializing(false)
          return
        }
        setSession(data.session ?? null)
        setInitializing(false)
      })
      .catch(() => {
        if (!mounted) return
        setSession(null)
        setInitializing(false)
      })

    const { data: sub } = sb.auth.onAuthStateChange((_evt, s) => {
      if (s && !isAllowedEmail(s.user.email)) {
        void sb.auth.signOut()
        setSession(null)
        setInitializing(false)
        return
      }
      setSession(s)
      setInitializing(false)
    })

    return () => {
      mounted = false
      sub.subscription.unsubscribe()
    }
  }, [])

  const value = useMemo<AuthState>(
    () => ({
      session,
      initializing,
      accounts: ['pedro@arkflow.ai'],
      signInWithGoogle: async () => {
        if (env.authMode === 'mock') return
        if (!supabase) throw new Error('Supabase auth is not configured')
        const currentOrigin = window.location.origin
        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        const origin = isLocalhost ? currentOrigin : (env.oauthRedirectTo ?? currentOrigin)
        const { error } = await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: `${origin}/auth/callback`,
          },
        })
        if (error) throw error
      },
      signOut: async () => {
        if (env.authMode === 'mock') {
          window.localStorage.removeItem('mock_email')
          setSession(null)
          return
        }
        if (!supabase) return
        const { error } = await supabase.auth.signOut()
        if (error) throw error
      },
    }),
    [session, initializing],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth must be used within AuthProvider')
  return v
}

