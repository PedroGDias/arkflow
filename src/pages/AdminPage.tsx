import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import '../styles/dashboard.css'

type Profile = {
  id: string
  email: string
  full_name: string | null
  role: 'internal' | 'client'
  disabled_at: string | null
  created_at: string
}

type ClientRow = { id: number; client_name: string | null }
type Mapping = { user_id: string; client_id: number }
type PendingInvite = { email: string; client_id: number; created_at: string }

export function AdminPage() {
  const { signOut, profile: meProfile } = useAuth()
  const nav = useNavigate()

  useEffect(() => { document.title = 'Admin · Arkflow' }, [])

  const [clients, setClients] = useState<ClientRow[]>([])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [mappings, setMappings] = useState<Mapping[]>([])
  const [pending, setPending] = useState<PendingInvite[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteClientIds, setInviteClientIds] = useState<Set<number>>(new Set())
  const [inviteMsg, setInviteMsg] = useState<string | null>(null)
  const [inviteErr, setInviteErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!supabase) return
    const sb = supabase
    setLoading(true)
    try {
      const [cRes, pRes, mRes, iRes] = await Promise.all([
        sb.from('clients').select('id,client_name').order('id'),
        sb.from('profiles').select('id,email,full_name,role,disabled_at,created_at').order('created_at', { ascending: false }),
        sb.from('client_users').select('user_id,client_id'),
        sb.from('pending_invites').select('email,client_id,created_at').order('created_at', { ascending: false }),
      ])
      if (cRes.error) throw cRes.error
      if (pRes.error) throw pRes.error
      if (mRes.error) throw mRes.error
      if (iRes.error) throw iRes.error
      setClients((cRes.data ?? []) as ClientRow[])
      setProfiles((pRes.data ?? []) as Profile[])
      setMappings((mRes.data ?? []) as Mapping[])
      setPending((iRes.data ?? []) as PendingInvite[])
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load admin data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const clientById = useMemo(() => {
    const m = new Map<number, string>()
    for (const c of clients) m.set(c.id, c.client_name?.trim() || `Client ${c.id}`)
    return m
  }, [clients])

  const clientsByUser = useMemo(() => {
    const m = new Map<string, number[]>()
    for (const row of mappings) {
      const list = m.get(row.user_id) ?? []
      list.push(row.client_id)
      m.set(row.user_id, list)
    }
    return m
  }, [mappings])

  const pendingByEmail = useMemo(() => {
    const m = new Map<string, number[]>()
    for (const row of pending) {
      const key = row.email.toLowerCase()
      const list = m.get(key) ?? []
      list.push(row.client_id)
      m.set(key, list)
    }
    return m
  }, [pending])

  async function inviteClient() {
    setInviteErr(null)
    setInviteMsg(null)
    const email = inviteEmail.trim().toLowerCase()
    if (!email) { setInviteErr('Enter an email'); return }
    if (inviteClientIds.size === 0) { setInviteErr('Pick at least one client'); return }
    if (!supabase) { setInviteErr('Supabase not configured'); return }

    setBusy('invite')
    try {
      const rows = Array.from(inviteClientIds).map((cid) => ({
        email,
        client_id: cid,
        invited_by: meProfile?.id ?? null,
      }))
      const insRes = await supabase
        .from('pending_invites')
        .upsert(rows, { onConflict: 'email,client_id' })
      if (insRes.error) throw insRes.error

      // Find an existing profile for this email — if they already have an
      // account, also assign the client mappings directly (no magic link needed
      // unless they're not logged in elsewhere).
      const existing = profiles.find((p) => p.email.toLowerCase() === email)
      if (existing) {
        const exRes = await supabase
          .from('client_users')
          .upsert(
            Array.from(inviteClientIds).map((cid) => ({ user_id: existing.id, client_id: cid })),
            { onConflict: 'user_id,client_id' },
          )
        if (exRes.error) throw exRes.error

        if (existing.disabled_at) {
          const enRes = await supabase
            .from('profiles')
            .update({ disabled_at: null })
            .eq('id', existing.id)
          if (enRes.error) throw enRes.error
        }

        // Clear the now-consumed pending invites for this email.
        await supabase.from('pending_invites').delete().eq('email', email)
        setInviteMsg(`Access granted to ${email}.`)
      } else {
        // Brand-new user: send them a magic link. The auth trigger will
        // consume the pending invites on first sign-in.
        const linkRes = await supabase.auth.signInWithOtp({
          email,
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback`,
            shouldCreateUser: true,
          },
        })
        if (linkRes.error) throw linkRes.error
        setInviteMsg(`Invite sent to ${email}. They’ll get a sign-in link by email.`)
      }
      setInviteEmail('')
      setInviteClientIds(new Set())
      await load()
    } catch (e) {
      setInviteErr(e instanceof Error ? e.message : 'Failed to invite')
    } finally {
      setBusy(null)
    }
  }

  async function setUserClient(userId: string, clientId: number, on: boolean) {
    if (!supabase) return
    setBusy(`${userId}:${clientId}`)
    try {
      if (on) {
        const res = await supabase
          .from('client_users')
          .upsert({ user_id: userId, client_id: clientId }, { onConflict: 'user_id,client_id' })
        if (res.error) throw res.error
      } else {
        const res = await supabase
          .from('client_users')
          .delete()
          .eq('user_id', userId)
          .eq('client_id', clientId)
        if (res.error) throw res.error
      }
      await load()
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to update access')
    } finally {
      setBusy(null)
    }
  }

  async function toggleDisabled(p: Profile) {
    if (!supabase) return
    setBusy(`disable:${p.id}`)
    try {
      const res = await supabase
        .from('profiles')
        .update({ disabled_at: p.disabled_at ? null : new Date().toISOString() })
        .eq('id', p.id)
      if (res.error) throw res.error
      await load()
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to update profile')
    } finally {
      setBusy(null)
    }
  }

  async function revokePending(email: string, clientId: number) {
    if (!supabase) return
    setBusy(`pending:${email}:${clientId}`)
    try {
      const res = await supabase
        .from('pending_invites')
        .delete()
        .eq('email', email)
        .eq('client_id', clientId)
      if (res.error) throw res.error
      await load()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="page">
      <header className="header">
        <div className="wrap">
          <a className="logo" href="/">
            <img src="/logos/arkflow-logo.svg" alt="Arkflow" className="logo-img" />
          </a>
          <div className="header-r">
            <div className="header-ctls">
              <button onClick={() => nav('/')} className="hdr-ctl hdr-btn">All clients</button>
              <button onClick={() => void signOut()} className="hdr-ctl hdr-btn">Sign out</button>
            </div>
          </div>
        </div>
      </header>

      <section className="topbar">
        <div className="wrap">
          <div className="topbar-label">Arkflow Admin</div>
          <h1>Access management</h1>

          {loadError ? <div className="error-msg" style={{ marginTop: 12 }}>{loadError}</div> : null}

          {/* ── Invite form ──────────────────────────────────────────────── */}
          <div style={card}>
            <div style={cardHead}>Invite a client</div>
            <div style={{ display: 'grid', gap: 12 }}>
              <input
                type="email"
                placeholder="client-contact@company.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.currentTarget.value)}
                style={inputStyle}
              />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {clients.map((c) => {
                  const active = inviteClientIds.has(c.id)
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setInviteClientIds((prev) => {
                          const next = new Set(prev)
                          if (next.has(c.id)) next.delete(c.id)
                          else next.add(c.id)
                          return next
                        })
                      }}
                      style={{
                        ...pillStyle,
                        background: active ? 'var(--text1)' : 'var(--white)',
                        color: active ? 'var(--white)' : 'var(--text2)',
                      }}
                    >
                      {c.client_name?.trim() || `Client ${c.id}`}
                    </button>
                  )
                })}
              </div>
              <div>
                <button
                  type="button"
                  onClick={() => void inviteClient()}
                  disabled={busy === 'invite' || !inviteEmail.trim() || inviteClientIds.size === 0}
                  style={primaryBtnStyle}
                >
                  {busy === 'invite' ? 'Sending…' : 'Send invite'}
                </button>
              </div>
              {inviteMsg ? <div style={{ color: 'var(--green)', fontSize: 12, fontFamily: 'var(--mono)' }}>{inviteMsg}</div> : null}
              {inviteErr ? <div className="error-msg">{inviteErr}</div> : null}
            </div>
          </div>

          {/* ── Users ──────────────────────────────────────────────────────── */}
          <div style={card}>
            <div style={cardHead}>Users ({profiles.length})</div>
            {loading ? <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text4)' }}>Loading…</div> : null}
            <div style={{ display: 'grid', gap: 14 }}>
              {profiles.map((p) => {
                const assigned = new Set(clientsByUser.get(p.id) ?? [])
                const isInternal = p.role === 'internal'
                return (
                  <div key={p.id} style={rowStyle}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{p.email}</div>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text4)' }}>
                          {p.full_name ? `${p.full_name} · ` : ''}{p.role}{p.disabled_at ? ' · disabled' : ''}
                        </div>
                      </div>
                      <button
                        onClick={() => void toggleDisabled(p)}
                        disabled={busy === `disable:${p.id}` || p.id === meProfile?.id}
                        style={{
                          ...subtleBtnStyle,
                          color: p.disabled_at ? 'var(--green)' : 'var(--red, #c33)',
                        }}
                      >
                        {p.disabled_at ? 'Re-enable' : 'Disable'}
                      </button>
                    </div>

                    {isInternal ? (
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text4)', marginTop: 8 }}>
                        Internal user — sees all clients.
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                        {clients.map((c) => {
                          const active = assigned.has(c.id)
                          const k = `${p.id}:${c.id}`
                          return (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => void setUserClient(p.id, c.id, !active)}
                              disabled={busy === k}
                              style={{
                                ...pillStyle,
                                background: active ? 'var(--text1)' : 'var(--white)',
                                color: active ? 'var(--white)' : 'var(--text2)',
                              }}
                            >
                              {c.client_name?.trim() || `Client ${c.id}`}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* ── Pending invites ────────────────────────────────────────────── */}
          {pending.length > 0 ? (
            <div style={card}>
              <div style={cardHead}>Pending invites ({Array.from(pendingByEmail.keys()).length})</div>
              <div style={{ display: 'grid', gap: 10 }}>
                {Array.from(pendingByEmail.entries()).map(([email, cids]) => (
                  <div key={email} style={rowStyle}>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{email}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                      {cids.map((cid) => (
                        <button
                          key={cid}
                          onClick={() => void revokePending(email, cid)}
                          style={pillStyle}
                          title="Click to revoke"
                          disabled={busy === `pending:${email}:${cid}`}
                        >
                          {clientById.get(cid) ?? `Client ${cid}`} ✕
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  )
}

const card: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 16,
  background: 'var(--white)',
  marginTop: 18,
}

const cardHead: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  letterSpacing: 0.5,
  textTransform: 'uppercase',
  color: 'var(--text3)',
  marginBottom: 12,
}

const rowStyle: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 12,
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  borderRadius: 10,
  border: '1px solid var(--border)',
  padding: '10px 12px',
  background: 'var(--white)',
  fontFamily: 'var(--mono)',
  fontSize: 13,
}

const pillStyle: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 999,
  padding: '6px 12px',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  cursor: 'pointer',
  background: 'var(--white)',
  color: 'var(--text2)',
}

const primaryBtnStyle: React.CSSProperties = {
  border: '1px solid var(--text1)',
  background: 'var(--text1)',
  color: 'var(--white)',
  borderRadius: 10,
  padding: '10px 16px',
  fontFamily: 'var(--mono)',
  fontSize: 13,
  cursor: 'pointer',
}

const subtleBtnStyle: React.CSSProperties = {
  border: '1px solid var(--border)',
  background: 'var(--white)',
  borderRadius: 8,
  padding: '6px 12px',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  cursor: 'pointer',
}
