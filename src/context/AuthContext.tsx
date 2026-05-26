import type { Session } from '@supabase/supabase-js'
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { env } from '../lib/env'
import { supabase } from '../lib/supabase'

type MockSession = { user: { email: string } }

export type Role = 'internal' | 'client'

export type Profile = {
  id: string
  email: string
  role: Role
  full_name: string | null
  disabled_at: string | null
}

type AuthState = {
  session: (Session | MockSession) | null
  initializing: boolean
  profile: Profile | null
  /** True once the profile load has resolved (success or failure) for the current session. */
  profileChecked: boolean
  /** Client ids the current user can access. For internal users this is `null` (= all). */
  accessibleClientIds: number[] | null
  /** True when profile.role === 'internal' and not disabled. */
  isInternal: boolean
  /** True when the user signed in but has no usable profile (disabled / not yet provisioned). */
  isLockedOut: boolean
  /** Error from the profile lookup, surfaced for debugging. */
  profileError: string | null
  signInWithGoogle: () => Promise<void>
  signInWithEmail: (email: string) => Promise<void>
  signOut: () => Promise<void>
  accounts: string[]
}

const Ctx = createContext<AuthState | null>(null)

function redirectOrigin(): string {
  const currentOrigin = window.location.origin
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  return isLocalhost ? currentOrigin : (env.oauthRedirectTo ?? currentOrigin)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<(Session | MockSession) | null>(null)
  const [initializing, setInitializing] = useState(true)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [profileChecked, setProfileChecked] = useState(false)
  const [accessibleClientIds, setAccessibleClientIds] = useState<number[] | null>(null)
  const [profileError, setProfileError] = useState<string | null>(null)

  const loadProfile = useCallback(async (userId: string) => {
    if (!supabase) {
      setProfileChecked(true)
      return
    }
    const sb = supabase

    try {
      const pRes = await sb
        .from('profiles')
        .select('id,email,role,full_name,disabled_at')
        .eq('id', userId)
        .maybeSingle()

      if (pRes.error) {
        console.error('[auth] profile lookup failed', pRes.error)
        setProfileError(`${pRes.error.code ?? ''} ${pRes.error.message}`.trim())
        setProfile(null)
        setAccessibleClientIds([])
        return
      }

      setProfileError(null)
      const prof = (pRes.data ?? null) as Profile | null
      setProfile(prof)

      if (!prof) {
        console.warn('[auth] no profile row for user', userId)
        setAccessibleClientIds([])
        return
      }
      if (prof.disabled_at) {
        setAccessibleClientIds([])
        return
      }
      if (prof.role === 'internal') {
        setAccessibleClientIds(null)
        return
      }
      const cuRes = await sb
        .from('client_users')
        .select('client_id')
        .eq('user_id', userId)
      if (cuRes.error) {
        console.error('[auth] client_users lookup failed', cuRes.error)
      }
      const ids = ((cuRes.data ?? []) as Array<{ client_id: number }>).map((r) => r.client_id)
      setAccessibleClientIds(ids)
    } finally {
      setProfileChecked(true)
    }
  }, [])

  useEffect(() => {
    if (env.authMode === 'mock') {
      const email = window.localStorage.getItem('mock_email')
      setSession(email ? ({ user: { email } } satisfies MockSession) : null)
      // Mock mode bypasses profiles — treat the configured account as internal.
      setProfile(email ? { id: 'mock', email, role: 'internal', full_name: null, disabled_at: null } : null)
      setAccessibleClientIds(email ? null : [])
      setProfileChecked(true)
      setInitializing(false)
      return
    }

    if (!supabase) {
      setSession(null)
      setProfileChecked(true)
      setInitializing(false)
      return
    }
    const sb = supabase

    let mounted = true
    sb.auth
      .getSession()
      .then(async ({ data }) => {
        if (!mounted) return
        setSession(data.session ?? null)
        if (data.session) {
          await loadProfile(data.session.user.id)
        } else {
          setProfileChecked(true)
        }
        setInitializing(false)
      })
      .catch(() => {
        if (!mounted) return
        setSession(null)
        setProfileChecked(true)
        setInitializing(false)
      })

    const { data: sub } = sb.auth.onAuthStateChange(async (_evt, s) => {
      setSession(s)
      if (s) {
        // Mark profile as "not yet checked" so ProtectedRoute waits, then load.
        setProfileChecked(false)
        await loadProfile(s.user.id)
      } else {
        setProfile(null)
        setAccessibleClientIds(null)
        setProfileChecked(true)
      }
      setInitializing(false)
    })

    return () => {
      mounted = false
      sub.subscription.unsubscribe()
    }
  }, [loadProfile])

  const value = useMemo<AuthState>(() => {
    const isInternal = !!profile && profile.role === 'internal' && !profile.disabled_at
    // Only declare "locked out" once we've actually checked the profile.
    const isLockedOut = !!session && profileChecked && (!profile || !!profile.disabled_at)
    return {
      session,
      initializing,
      profile,
      profileChecked,
      accessibleClientIds,
      isInternal,
      isLockedOut,
      profileError,
      accounts: ['pedro@arkflow.ai'],
      signInWithGoogle: async () => {
        if (env.authMode === 'mock') return
        if (!supabase) throw new Error('Supabase auth is not configured')
        const { error } = await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: { redirectTo: `${redirectOrigin()}/auth/callback` },
        })
        if (error) throw error
      },
      signInWithEmail: async (email: string) => {
        if (env.authMode === 'mock') return
        if (!supabase) throw new Error('Supabase auth is not configured')
        const trimmed = email.trim().toLowerCase()
        if (!trimmed) throw new Error('Enter an email address')
        const { error } = await supabase.auth.signInWithOtp({
          email: trimmed,
          options: { emailRedirectTo: `${redirectOrigin()}/auth/callback` },
        })
        if (error) throw error
      },
      signOut: async () => {
        if (env.authMode === 'mock') {
          window.localStorage.removeItem('mock_email')
          setSession(null)
          setProfile(null)
          setAccessibleClientIds(null)
          return
        }
        if (!supabase) return
        const { error } = await supabase.auth.signOut()
        if (error) throw error
      },
    }
  }, [session, initializing, profile, profileChecked, accessibleClientIds, profileError])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth must be used within AuthProvider')
  return v
}
