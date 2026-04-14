import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { isAllowedEmail } from '../lib/authz'
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
    const sb = supabase
    let mounted = true
    sb.auth
      .getSession()
      .then(({ data, error }) => {
        if (!mounted) return
        if (error) throw error
        if (!data.session) throw new Error('No session after callback')

        const email = data.session.user.email
        if (!isAllowedEmail(email)) {
          void sb.auth.signOut()
          throw new Error('Please sign in with your @arkflow.ai Google account.')
        }

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
        <div style={{ width: 'min(520px, 100%)' }}>
          <div className="error-msg" style={{ marginBottom: 12 }}>
            {err}
          </div>
          <button
            onClick={() => nav('/login', { replace: true })}
            style={{
              width: '100%',
              borderRadius: 10,
              border: '1px solid var(--border)',
              padding: '12px 14px',
              background: 'var(--white)',
              fontFamily: 'var(--mono)',
              cursor: 'pointer',
            }}
          >
            Back to login
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="loading">
      <div className="spinner"></div>Signing you in…
    </div>
  )
}

