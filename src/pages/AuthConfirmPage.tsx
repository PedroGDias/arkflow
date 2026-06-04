import type { EmailOtpType } from '@supabase/supabase-js'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { env } from '../lib/env'
import { supabase } from '../lib/supabase'

// Where email sign-in links land. The link in the email points HERE (not at
// GoTrue's /auth/v1/verify), and sign-in is completed by a verifyOtp POST that
// only fires when the user taps the button. That matters because corporate mail
// security (Microsoft Safe Links, Mimecast, …) pre-fetches links with an
// automated GET to scan them — and GoTrue's /verify consumes its one-time token
// on that GET, so the user's real click would arrive to an already-spent token
// ("otp_expired"). A GET to this page consumes nothing; only the click does.

function readParams(): { tokenHash: string | null; type: EmailOtpType | null; errorDescription: string | null } {
  // GoTrue puts failures (e.g. an already-consumed/expired token) in the hash;
  // our own params come through the query string. Check both.
  const query = new URLSearchParams(window.location.search)
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const get = (k: string) => query.get(k) ?? hash.get(k)
  return {
    tokenHash: get('token_hash'),
    type: (get('type') as EmailOtpType | null) ?? null,
    errorDescription: get('error_description'),
  }
}

export function AuthConfirmPage() {
  const nav = useNavigate()
  const { tokenHash, type, errorDescription } = useMemo(readParams, [])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(errorDescription)

  useEffect(() => {
    if (env.authMode !== 'supabase' || !supabase) nav('/', { replace: true })
  }, [nav])

  async function confirm() {
    if (!supabase || !tokenHash) {
      setErr('This sign-in link is missing its token. Please request a new link.')
      return
    }
    setErr(null)
    setBusy(true)
    try {
      const { error } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: type ?? 'magiclink',
      })
      if (error) throw error
      // AuthContext picks up the SIGNED_IN session; role-aware routing handles the landing page.
      nav('/', { replace: true })
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Sign-in failed. The link may have expired — request a new one.')
    } finally {
      setBusy(false)
    }
  }

  const linkBroken = !tokenHash || !!errorDescription

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ width: 'min(420px, 100%)' }}>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 34, marginBottom: 10 }}>Arkflow</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text3)', marginBottom: 18 }}>
          {linkBroken ? 'Sign-in link' : 'One more tap to sign in to your dashboard'}
        </div>

        {err ? (
          <div className="error-msg" style={{ marginBottom: 12 }}>
            {err}
          </div>
        ) : null}

        {linkBroken ? (
          <button
            onClick={() => nav('/login', { replace: true })}
            style={{
              width: '100%', borderRadius: 10, border: '1px solid var(--border)',
              padding: '12px 14px', background: 'var(--white)',
              fontFamily: 'var(--mono)', cursor: 'pointer',
            }}
          >
            Back to login
          </button>
        ) : (
          <button
            onClick={() => void confirm()}
            disabled={busy}
            style={{
              width: '100%', borderRadius: 10, border: '1px solid var(--border)',
              padding: '12px 14px', background: 'var(--white)',
              fontFamily: 'var(--mono)', cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? 'Signing you in…' : 'Sign in to Arkflow'}
          </button>
        )}
      </div>
    </div>
  )
}
