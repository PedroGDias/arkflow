import { useState } from 'react'
import { useAuth } from '../context/AuthContext'

// Header control: a "Password" button that opens a small modal letting the
// signed-in user set a new password (supabase.auth.updateUser — no email round
// trip, so no link for mail security to intercept). Rendered as a fixed overlay
// so it doesn't disturb the header layout it's dropped into.
export function ChangePassword() {
  const { changePassword } = useAuth()
  const [open, setOpen] = useState(false)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  function close() {
    setOpen(false)
    setPw('')
    setPw2('')
    setErr(null)
    setDone(false)
  }

  async function submit() {
    setErr(null)
    if (pw !== pw2) {
      setErr('Passwords don’t match')
      return
    }
    setBusy(true)
    try {
      await changePassword(pw)
      setDone(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to update password')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" className="hdr-ctl hdr-btn" onClick={() => setOpen(true)}>
        Password
      </button>

      {open ? (
        <div
          onClick={close}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center',
            background: 'rgba(52,48,42,0.28)', backdropFilter: 'blur(2px)', padding: 24,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(380px, 100%)', background: 'var(--white)', borderRadius: 'var(--radius-lg)',
              border: '1px solid var(--border)', boxShadow: 'var(--shadow-card)', padding: 22,
            }}
          >
            <div style={{ fontFamily: 'var(--serif)', fontSize: 20, marginBottom: 4 }}>Change password</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text3)', marginBottom: 16 }}>
              Set a new password for this account.
            </div>

            {done ? (
              <>
                <div
                  style={{
                    fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text2)',
                    background: 'var(--brand-bg)', border: '1px solid var(--border)',
                    borderRadius: 10, padding: '12px 14px', marginBottom: 14, lineHeight: 1.6,
                  }}
                >
                  Password updated.
                </div>
                <button type="button" className="hdr-ctl hdr-btn" style={{ width: '100%' }} onClick={close}>
                  Done
                </button>
              </>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void submit()
                }}
                style={{ display: 'grid', gap: 8 }}
              >
                {err ? <div className="error-msg" style={{ marginBottom: 4 }}>{err}</div> : null}
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  placeholder="New password (8+ characters)"
                  value={pw}
                  onChange={(e) => setPw(e.currentTarget.value)}
                  style={fieldStyle}
                />
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  placeholder="Confirm new password"
                  value={pw2}
                  onChange={(e) => setPw2(e.currentTarget.value)}
                  style={fieldStyle}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button
                    type="button"
                    onClick={close}
                    className="hdr-ctl hdr-btn"
                    style={{ flex: 1 }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={busy || !pw || !pw2}
                    className="hdr-ctl hdr-btn"
                    style={{ flex: 1, opacity: busy || !pw || !pw2 ? 0.6 : 1, cursor: busy ? 'wait' : 'pointer' }}
                  >
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      ) : null}
    </>
  )
}

const fieldStyle: React.CSSProperties = {
  width: '100%', borderRadius: 10, border: '1px solid var(--border)',
  padding: '11px 13px', background: 'var(--white)', fontFamily: 'var(--mono)', fontSize: 13,
}
