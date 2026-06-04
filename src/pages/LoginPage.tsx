import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { env } from '../lib/env'

export function LoginPage() {
  const { session, initializing, profileChecked, isLockedOut, profileError, signInWithGoogle, signInWithEmailPassword, requestPasswordReset, signOut, accounts } = useAuth()
  const nav = useNavigate()
  const loc = useLocation()
  const [err, setErr] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [signingIn, setSigningIn] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetSentTo, setResetSentTo] = useState<string | null>(null)

  // If we land on /login while authenticated and the profile is OK, bounce home.
  useEffect(() => {
    if (initializing) return
    if (!session) return
    if (!profileChecked) return
    if (isLockedOut) return
    const from = (loc.state as { from?: string } | null)?.from
    nav(from ?? '/', { replace: true })
  }, [session, initializing, profileChecked, isLockedOut, nav, loc.state])

  if (env.authMode === 'mock') {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div style={{ width: 'min(520px, 100%)' }}>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 34, marginBottom: 10 }}>Arkflow</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text3)', marginBottom: 18 }}>
            Select an account to simulate Google SSO
          </div>

          {err ? <div className="error-msg" style={{ marginBottom: 12 }}>{err}</div> : null}

          <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', background: 'var(--white)' }}>
            {accounts.map((acct) => (
              <button
                key={acct}
                onClick={() => {
                  try {
                    window.localStorage.setItem('mock_email', acct)
                    nav('/', { replace: true })
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : 'Failed to store session')
                  }
                }}
                style={{
                  width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center',
                  justifyContent: 'space-between', gap: 12, padding: '12px 14px',
                  background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)',
                  cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text2)',
                }}
              >
                <span>{acct}</span>
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
          Sign in to view your dashboard
        </div>

        {isLockedOut ? (
          <div className="error-msg" style={{ marginBottom: 12 }}>
            <div>This account doesn’t have access yet. Please ask an Arkflow admin to invite you.</div>
            {profileError ? (
              <div style={{ marginTop: 8, fontSize: 11, opacity: 0.8 }}>
                Debug: {profileError}
              </div>
            ) : null}
            <button
              onClick={() => void signOut()}
              style={{
                marginTop: 10, padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 11,
                border: '1px solid currentColor', background: 'transparent', cursor: 'pointer', color: 'inherit', borderRadius: 6,
              }}
            >
              Sign out and try another account
            </button>
          </div>
        ) : null}

        {err ? <div className="error-msg" style={{ marginBottom: 12 }}>{err}</div> : null}

        {resetSentTo ? (
          <div
            style={{
              marginBottom: 12,
              padding: '12px 14px',
              border: '1px solid var(--border)',
              borderRadius: 10,
              background: 'var(--white)',
              fontFamily: 'var(--mono)',
              fontSize: 12,
              color: 'var(--text2)',
              lineHeight: 1.6,
            }}
          >
            If an account exists for <strong>{resetSentTo}</strong>, a new password is on its way. Check your email, then sign in below.
          </div>
        ) : null}

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
            width: '100%', borderRadius: 10, border: '1px solid var(--border)',
            padding: '12px 14px', background: 'var(--white)',
            fontFamily: 'var(--mono)', cursor: 'pointer',
          }}
        >
          Continue with Google
        </button>

        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            margin: '14px 0', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text4)',
          }}
        >
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          <span>OR</span>
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        </div>

        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setErr(null)
            setSigningIn(true)
            try {
              await signInWithEmailPassword(email, password)
              // ProtectedRoute / the redirect effect above take it from here.
            } catch (e2) {
              setErr(e2 instanceof Error ? e2.message : 'Sign-in failed')
            } finally {
              setSigningIn(false)
            }
          }}
          style={{ display: 'grid', gap: 8 }}
        >
          <input
            type="email"
            autoComplete="email"
            required
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            style={{
              width: '100%', borderRadius: 10, border: '1px solid var(--border)',
              padding: '12px 14px', background: 'var(--white)', fontFamily: 'var(--mono)', fontSize: 13,
            }}
          />
          <input
            type="password"
            autoComplete="current-password"
            required
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            style={{
              width: '100%', borderRadius: 10, border: '1px solid var(--border)',
              padding: '12px 14px', background: 'var(--white)', fontFamily: 'var(--mono)', fontSize: 13,
            }}
          />
          <button
            type="submit"
            disabled={signingIn || !email.trim() || !password}
            style={{
              width: '100%', borderRadius: 10, border: '1px solid var(--border)',
              padding: '12px 14px', background: 'var(--white)',
              fontFamily: 'var(--mono)', cursor: signingIn ? 'wait' : 'pointer',
              opacity: signingIn || !email.trim() || !password ? 0.6 : 1,
            }}
          >
            {signingIn ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <button
          type="button"
          disabled={resetting || !email.trim()}
          onClick={async () => {
            setErr(null)
            setResetSentTo(null)
            setResetting(true)
            try {
              await requestPasswordReset(email)
              setResetSentTo(email.trim().toLowerCase())
            } catch (e2) {
              setErr(e2 instanceof Error ? e2.message : 'Failed to request a new password')
            } finally {
              setResetting(false)
            }
          }}
          style={{
            marginTop: 12, background: 'none', border: 'none', padding: 0,
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text3)',
            cursor: resetting || !email.trim() ? 'default' : 'pointer',
            textDecoration: 'underline', opacity: resetting || !email.trim() ? 0.5 : 1,
          }}
        >
          {resetting ? 'Sending…' : 'Forgot your password? Email me a new one'}
        </button>
      </div>
    </div>
  )
}
