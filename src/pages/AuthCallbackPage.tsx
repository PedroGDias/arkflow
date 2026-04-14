import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { env } from '../lib/env'
import { supabase } from '../lib/supabase'

export function AuthCallbackPage() {
  const nav = useNavigate()
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (env.authMode !== 'supabase' || !supabase) {
      nav('/', { replace: true })
      return
    }
    let mounted = true
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!mounted) return
        if (error) throw error
        if (!data.session) throw new Error('No session after callback')
        nav('/', { replace: true })
      })
      .catch((e) => {
        if (!mounted) return
        setErr(e instanceof Error ? e.message : 'Auth callback failed')
      })

    return () => {
      mounted = false
    }
  }, [nav])

  if (err) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div className="error-msg">{err}</div>
      </div>
    )
  }

  return (
    <div className="loading">
      <div className="spinner"></div>Signing you in…
    </div>
  )
}

