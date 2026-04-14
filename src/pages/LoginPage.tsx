import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { env } from '../lib/env'

export function LoginPage() {
  const { session, initializing, signInWithGoogle, accounts } = useAuth()
  const nav = useNavigate()
  const loc = useLocation()
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (initializing) return
    if (session) {
      const from = (loc.state as { from?: string } | null)?.from
      nav(from ?? '/', { replace: true })
    }
  }, [session, initializing, nav, loc.state])

  if (env.authMode === 'mock') {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div style={{ width: 'min(520px, 100%)' }}>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 34, marginBottom: 10 }}>Arkflow</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text3)', marginBottom: 18 }}>
            Select an account to simulate Google SSO
          </div>

          {err ? (
            <div className="error-msg" style={{ marginBottom: 12 }}>
              {err}
            </div>
          ) : null}

          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 12,
              overflow: 'hidden',
              background: 'var(--white)',
            }}
          >
            {accounts.map((email) => (
              <button
                key={email}
                onClick={() => {
                  try {
                    window.localStorage.setItem('mock_email', email)
                    nav('/', { replace: true })
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : 'Failed to store session')
                  }
                }}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '12px 14px',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: '1px solid var(--border)',
                  cursor: 'pointer',
                  fontFamily: 'var(--mono)',
                  fontSize: 12,
                  color: 'var(--text2)',
                }}
              >
                <span>{email}</span>
                <span style={{ color: 'var(--text4)' }}>Select</span>
              </button>
            ))}
          </div>

          <div style={{ marginTop: 12, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text4)', lineHeight: 1.6 }}>
            Auth mode: <span style={{ color: 'var(--text3)' }}>mock</span>. No Google/Supabase configuration required.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ width: 'min(420px, 100%)' }}>
        <div style={{ fontFamily: "var(--serif)", fontSize: 34, marginBottom: 10 }}>Arkflow</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text3)', marginBottom: 18 }}>
          Sign in to view the ROI dashboard
        </div>

        {err ? <div className="error-msg" style={{ marginBottom: 12 }}>{err}</div> : null}

        <button
          onClick={async () => {
            setErr(null)
            try {
              await signInWithGoogle()
            } catch (e) {
              setErr(e instanceof Error ? e.message : 'Failed to start sign-in')
            }
          }}
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
          Continue with Google
        </button>

        <div style={{ marginTop: 12, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text4)', lineHeight: 1.6 }}>
          If this page loops, check Supabase Auth settings and allowed redirect URLs.
        </div>
      </div>
    </div>
  )
}

