import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { Tooltip } from '../components/Tooltip'
import '../styles/dashboard.css'

type ClientRow = { id: number; client_name: string | null }
type Member = {
  user_id: string
  client_id: number
  email: string
  full_name: string | null
  role: 'internal' | 'client'
  disabled_at: string | null
  can_manage: boolean
}
type PendingInvite = { email: string; client_id: number; created_at: string }

export function ClientTeamPage() {
  const { signOut, profile: meProfile } = useAuth()
  const nav = useNavigate()

  useEffect(() => { document.title = 'Manage access · Arkflow' }, [])

  const [clients, setClients] = useState<ClientRow[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [pending, setPending] = useState<PendingInvite[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // Per-client invite email + feedback.
  const [inviteEmail, setInviteEmail] = useState<Record<number, string>>({})
  const [rowMsg, setRowMsg] = useState<Record<number, string | null>>({})
  const [rowErr, setRowErr] = useState<Record<number, string | null>>({})

  const load = useCallback(async () => {
    if (!supabase) return
    setLoading(true)
    try {
      const { data, error } = await supabase.rpc('client_team_overview')
      if (error) throw error
      const payload = (data ?? {}) as {
        clients?: ClientRow[]
        members?: Member[]
        pending_invites?: PendingInvite[]
      }
      setClients(payload.clients ?? [])
      setMembers(payload.members ?? [])
      setPending(payload.pending_invites ?? [])
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const membersByClient = useMemo(() => {
    const m = new Map<number, Member[]>()
    for (const row of members) {
      const list = m.get(row.client_id) ?? []
      list.push(row)
      m.set(row.client_id, list)
    }
    return m
  }, [members])

  const pendingByClient = useMemo(() => {
    const m = new Map<number, PendingInvite[]>()
    for (const row of pending) {
      const list = m.get(row.client_id) ?? []
      list.push(row)
      m.set(row.client_id, list)
    }
    return m
  }, [pending])

  async function grant(clientId: number) {
    const email = (inviteEmail[clientId] ?? '').trim().toLowerCase()
    setRowErr((s) => ({ ...s, [clientId]: null }))
    setRowMsg((s) => ({ ...s, [clientId]: null }))
    if (!email || !email.includes('@')) {
      setRowErr((s) => ({ ...s, [clientId]: 'Enter a valid email' }))
      return
    }
    if (!supabase) return
    setBusy(`grant:${clientId}`)
    try {
      const { error } = await supabase.rpc('grant_client_access', { p_email: email, p_client_id: clientId })
      if (error) throw error
      setInviteEmail((s) => ({ ...s, [clientId]: '' }))
      setRowMsg((s) => ({ ...s, [clientId]: `Access granted to ${email}. They'll get a sign-in link if they don't have an account.` }))
      await load()
    } catch (e) {
      setRowErr((s) => ({ ...s, [clientId]: e instanceof Error ? e.message : 'Failed to grant access' }))
    } finally {
      setBusy(null)
    }
  }

  async function revokeMember(userId: string, clientId: number) {
    if (!supabase) return
    setBusy(`rm:${userId}:${clientId}`)
    try {
      const { error } = await supabase.rpc('revoke_client_access', { p_user_id: userId, p_client_id: clientId })
      if (error) throw error
      await load()
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to revoke access')
    } finally {
      setBusy(null)
    }
  }

  async function revokeInvite(email: string, clientId: number) {
    if (!supabase) return
    setBusy(`inv:${email}:${clientId}`)
    try {
      const { error } = await supabase.rpc('revoke_client_invite', { p_email: email, p_client_id: clientId })
      if (error) throw error
      await load()
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to revoke invite')
    } finally {
      setBusy(null)
    }
  }

  return (
    // Arkflow-owned page: neutral identity, not a client's green brand.
    <div
      className="page"
      style={{
        ['--brand' as never]: 'var(--black)',
        ['--brand-bg' as never]: 'var(--card)',
        ['--chart-bar' as never]: 'var(--black)',
      }}
    >
      <header className="header">
        <div className="wrap">
          <a className="logo" href="/">
            <img src="/logos/arkflow-logo.svg" alt="Arkflow" className="logo-img" />
          </a>
          <div className="header-r">
            <div className="header-ctls">
              <button onClick={() => nav('/')} className="hdr-ctl hdr-btn">Back</button>
              <button onClick={() => void signOut()} className="hdr-ctl hdr-btn">Sign out</button>
            </div>
          </div>
        </div>
      </header>

      <section className="topbar">
        <div className="wrap">
          <div className="topbar-label">Team access</div>
          <h1>Manage access</h1>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text3)', marginTop: 6, maxWidth: 620 }}>
            Invite teammates to the dashboards you manage, or revoke their access. New people get an email sign-in link.
          </div>

          {loadError ? <div className="error-msg" style={{ marginTop: 12 }}>{loadError}</div> : null}
          {loading ? <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text4)', marginTop: 12 }}>Loading…</div> : null}

          {!loading && clients.length === 0 ? (
            <div style={card}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text4)' }}>
                You don't manage access for any dashboards yet.
              </div>
            </div>
          ) : null}

          {clients.map((c) => {
            const cName = c.client_name?.trim() || `Client ${c.id}`
            const mem = (membersByClient.get(c.id) ?? []).filter((m) => m.role !== 'internal')
            const inv = pendingByClient.get(c.id) ?? []
            return (
              <div key={c.id} style={card}>
                <div style={cardHead}>{cName}</div>

                {/* Invite */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input
                    type="email"
                    placeholder="teammate@company.com"
                    value={inviteEmail[c.id] ?? ''}
                    onChange={(e) => {
                      const v = e.currentTarget.value
                      setInviteEmail((s) => ({ ...s, [c.id]: v }))
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter') void grant(c.id) }}
                    style={{ ...inputStyle, maxWidth: 320 }}
                  />
                  <button
                    type="button"
                    onClick={() => void grant(c.id)}
                    disabled={busy === `grant:${c.id}` || !(inviteEmail[c.id] ?? '').trim()}
                    style={primaryBtnStyle}
                  >
                    {busy === `grant:${c.id}` ? 'Granting…' : 'Grant access'}
                  </button>
                </div>
                {rowErr[c.id] ? <div className="error-msg" style={{ marginTop: 8 }}>{rowErr[c.id]}</div> : null}
                {rowMsg[c.id] ? <div style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text3)' }}>{rowMsg[c.id]}</div> : null}

                {/* Members with access */}
                <div style={{ display: 'grid', gap: 8, marginTop: 14 }}>
                  {mem.length === 0 && inv.length === 0 ? (
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text4)' }}>No teammates yet.</div>
                  ) : null}

                  {mem.map((m) => {
                    const isSelf = m.user_id === meProfile?.id
                    return (
                      <div key={m.user_id} style={{ ...rowStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <div>
                          <div style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{m.email}</div>
                          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text4)' }}>
                            {m.full_name ? `${m.full_name} · ` : ''}
                            {m.can_manage ? 'manager' : 'member'}
                            {m.disabled_at ? ' · disabled' : ''}
                            {isSelf ? ' · you' : ''}
                          </div>
                        </div>
                        <Tooltip label={isSelf ? 'Remove your own access to this client' : 'Revoke access'}>
                          <button
                            type="button"
                            onClick={() => void revokeMember(m.user_id, c.id)}
                            disabled={busy === `rm:${m.user_id}:${c.id}`}
                            style={{ ...subtleBtnStyle, color: 'var(--red, #c33)' }}
                          >
                            Revoke
                          </button>
                        </Tooltip>
                      </div>
                    )
                  })}

                  {inv.map((p) => (
                    <div key={`${p.email}:${p.client_id}`} style={{ ...rowStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{p.email}</div>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text4)' }}>invited · awaiting sign-in</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void revokeInvite(p.email, c.id)}
                        disabled={busy === `inv:${p.email}:${c.id}`}
                        style={{ ...subtleBtnStyle, color: 'var(--red, #c33)' }}
                      >
                        Cancel invite
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

const card: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-lg, 14px)',
  padding: 16,
  background: 'var(--white)',
  marginTop: 18,
  boxShadow: 'var(--shadow-sm)',
}

const cardHead: React.CSSProperties = {
  fontFamily: 'var(--serif)',
  fontSize: 18,
  color: 'var(--text)',
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
  borderRadius: 10,
  padding: '8px 12px',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  cursor: 'pointer',
}
