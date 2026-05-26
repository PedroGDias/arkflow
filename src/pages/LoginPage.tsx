import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { env } from '../lib/env'

export function LoginPage() {
  const { session, initializing, signInWithGoogle, signInWithEmail, signOut, accounts } = useAuth()
  const nav = useNavigate()
  const loc = useLocation()
  const [err, setErr] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [sendingLink, setSendingLink] = useState(false)
  const [linkSentTo, setLinkSentTo] = useState<string | null>(null)
  const locked = (loc.state as { locked?: boolean } | null)?.locked === true

  useEffect(() => {
    if (initializing) return
    if (session && !locked) {
      const from = (loc.state as { from?: string } | null)?.from
      nav(from ?? '/', { replace: true })
    }
  }, [session, initializing, nav, loc.state, locked])

  // If the user was redirected here because their profile is disabled,
  // make sure no stale session is hanging around.
  useEffect(() => {
    if (locked) void signOut()
  }, [locked, signOut])

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

        {locked ? (
          <div className="error-msg" style={{ marginBottom: 12 }}>
            This account doesn’t have access yet. Please ask an Arkflow admin to invite you.
          </div>
        ) : null}

        {err ? <div className="error-msg" style={{ marginBottom: 12 }}>{err}</div> : null}

        {linkSentTo ? (
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
            We’ve sent a sign-in link to <strong>{linkSentTo}</strong>. Click the link in the email to continue.
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
            setLinkSentTo(null)
            setSendingLink(true)
            try {
              await signInWithEmail(email)
              setLinkSentTo(email.trim().toLowerCase())
            } catch (e2) {
              setErr(e2 instanceof Error ? e2.message : 'Failed to send sign-in link')
            } finally {
              setSendingLink(false)
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
          <button
            type="submit"
            disabled={sendingLink || !email.trim()}
            style={{
              width: '100%', borderRadius: 10, border: '1px solid var(--border)',
              padding: '12px 14px', background: 'var(--white)',
              fontFamily: 'var(--mono)', cursor: sendingLink ? 'wait' : 'pointer',
              opacity: sendingLink || !email.trim() ? 0.6 : 1,
            }}
          >
            {sendingLink ? 'Sending link…' : 'Email me a sign-in link'}
          </button>
        </form>

        <div style={{ marginTop: 12, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text4)', lineHeight: 1.6 }}>
          If this page loops, check Supabase Auth settings and allowed redirect URLs.
        </div>
      </div>
    </div>
  )
}
