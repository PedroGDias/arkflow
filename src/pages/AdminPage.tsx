import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { Tooltip } from '../components/Tooltip'
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
type Mapping = { user_id: string; client_id: number; can_manage?: boolean }
type PendingInvite = { email: string; client_id: number; created_at: string }
type AdminEmail = { email: string; created_at: string }

export function AdminPage() {
  const { signOut, profile: meProfile } = useAuth()
  const nav = useNavigate()

  useEffect(() => { document.title = 'Admin · Arkflow' }, [])

  const [clients, setClients] = useState<ClientRow[]>([])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [mappings, setMappings] = useState<Mapping[]>([])
  const [pending, setPending] = useState<PendingInvite[]>([])
  const [adminEmails, setAdminEmails] = useState<AdminEmail[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteClientIds, setInviteClientIds] = useState<Set<number>>(new Set())
  const [inviteMsg, setInviteMsg] = useState<string | null>(null)
  const [inviteErr, setInviteErr] = useState<string | null>(null)

  const [newAdminEmail, setNewAdminEmail] = useState('')
  const [adminErr, setAdminErr] = useState<string | null>(null)
  const [adminMsg, setAdminMsg] = useState<string | null>(null)

  const [usersMsg, setUsersMsg] = useState<string | null>(null)
  const [usersErr, setUsersErr] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!supabase) return
    const sb = supabase
    try {
      // Single SECURITY DEFINER RPC that checks is_internal() server-side and
      // returns all admin data. Avoids depending on five separate
      // authenticated-RLS table reads from the browser.
      const { data, error } = await sb.rpc('admin_overview')
      if (error) throw error

      const payload = (data ?? {}) as {
        clients?: ClientRow[]
        profiles?: Profile[]
        client_users?: Mapping[]
        pending_invites?: PendingInvite[]
        admin_emails?: AdminEmail[]
      }
      setClients(payload.clients ?? [])
      setProfiles(payload.profiles ?? [])
      setMappings(payload.client_users ?? [])
      setPending(payload.pending_invites ?? [])
      setAdminEmails(payload.admin_emails ?? [])
      setLoadError(null)
    } catch (e) {
      let msg = 'Failed to load admin data'
      if (e instanceof Error) msg = e.message
      else if (e && typeof e === 'object') {
        const pe = e as { message?: string; code?: string }
        msg = [pe.message, pe.code ? `(${pe.code})` : null].filter(Boolean).join(' ') || msg
      }
      console.error('[admin] load failed', e)
      setLoadError(msg)
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

  // `${user_id}:${client_id}` for mappings flagged as members-manager.
  const managerKeys = useMemo(() => {
    const s = new Set<string>()
    for (const row of mappings) if (row.can_manage) s.add(`${row.user_id}:${row.client_id}`)
    return s
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
      // Record the invite so a brand-new user is auto-mapped on first sign-in
      // (the auth trigger consumes these rows).
      const insRes = await supabase
        .from('pending_invites')
        .upsert(rows, { onConflict: 'email,client_id' })
      if (insRes.error) throw insRes.error

      // If they already have an account, apply the client mappings + re-enable
      // right away (the magic link below still gets sent so they can sign in).
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

        // Mappings applied directly — no need for the trigger to replay them.
        await supabase.from('pending_invites').delete().eq('email', email)
      }

      // Always send a fresh sign-in link, new or existing. shouldCreateUser
      // makes this also provision a brand-new account.
      const linkRes = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
          shouldCreateUser: true,
        },
      })
      if (linkRes.error) throw linkRes.error
      setInviteMsg(
        existing
          ? `Access updated and a sign-in link sent to ${email}.`
          : `Sign-in link sent to ${email}. If it doesn’t arrive, check spam.`,
      )
      setInviteEmail('')
      setInviteClientIds(new Set())
      await load()
    } catch (e) {
      setInviteErr(e instanceof Error ? e.message : 'Failed to invite')
    } finally {
      setBusy(null)
    }
  }

  // Email an existing user a fresh magic sign-in link. Surfaces the real result
  // (incl. Supabase rate-limit / SMTP errors) so the admin knows whether it sent.
  async function resendLink(email: string, userId: string) {
    if (!supabase) return
    setUsersMsg(null)
    setUsersErr(null)
    setBusy(`resend:${userId}`)
    try {
      const res = await supabase.auth.signInWithOtp({
        email: email.toLowerCase(),
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
          shouldCreateUser: false,
        },
      })
      if (res.error) throw res.error
      setUsersMsg(`Sign-in link sent to ${email}.`)
    } catch (e) {
      setUsersErr(e instanceof Error ? e.message : `Failed to send link to ${email}`)
    } finally {
      setBusy(null)
    }
  }

  // Hard-delete via the admin_delete_user RPC (removes the auth user, cascading
  // to the profile + client mappings, and clears their invite/admin entries).
  async function deleteUser(p: Profile) {
    if (!supabase) return
    setUsersMsg(null)
    setUsersErr(null)
    setBusy(`del:${p.id}`)
    try {
      const res = await supabase.rpc('admin_delete_user', { target: p.id })
      if (res.error) throw res.error
      setConfirmDel(null)
      setUsersMsg(`Deleted ${p.email}.`)
      await load()
    } catch (e) {
      setUsersErr(e instanceof Error ? e.message : `Failed to delete ${p.email}`)
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

  // Flag/unflag a (user, client) mapping as a members-manager: that user can
  // then invite/revoke other users for that client from /manage.
  async function setUserClientManage(userId: string, clientId: number, canManage: boolean) {
    if (!supabase) return
    setBusy(`mgr:${userId}:${clientId}`)
    try {
      const res = await supabase
        .from('client_users')
        .update({ can_manage: canManage })
        .eq('user_id', userId)
        .eq('client_id', clientId)
      if (res.error) throw res.error
      await load()
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to update manager flag')
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

  async function addAdmin() {
    setAdminErr(null)
    setAdminMsg(null)
    const email = newAdminEmail.trim().toLowerCase()
    if (!email || !email.includes('@')) { setAdminErr('Enter a valid email'); return }
    if (!supabase) { setAdminErr('Supabase not configured'); return }

    setBusy('add-admin')
    try {
      const insRes = await supabase
        .from('admin_emails')
        .upsert({ email }, { onConflict: 'email' })
      if (insRes.error) throw insRes.error

      // If this email already has a profile, promote it to internal/enabled
      // immediately. Otherwise the auth trigger will handle it on first sign-in.
      const existing = profiles.find((p) => p.email.toLowerCase() === email)
      if (existing) {
        const upRes = await supabase
          .from('profiles')
          .update({ role: 'internal', disabled_at: null })
          .eq('id', existing.id)
        if (upRes.error) throw upRes.error
        setAdminMsg(`${email} promoted to admin.`)
      } else {
        setAdminMsg(`${email} added. They'll become an admin on first sign-in.`)
      }
      setNewAdminEmail('')
      await load()
    } catch (e) {
      setAdminErr(e instanceof Error ? e.message : 'Failed to add admin')
    } finally {
      setBusy(null)
    }
  }

  async function removeAdmin(email: string) {
    if (!supabase) return
    const normalized = email.toLowerCase()
    if (normalized === meProfile?.email.toLowerCase()) {
      setAdminErr("You can't remove yourself.")
      return
    }
    // Guard: never remove the last active admin.
    const otherActiveAdmins = profiles.filter(
      (p) => p.role === 'internal' && !p.disabled_at && p.email.toLowerCase() !== normalized,
    )
    if (otherActiveAdmins.length === 0) {
      setAdminErr("Can't remove the last active admin.")
      return
    }

    setBusy(`rm-admin:${normalized}`)
    setAdminErr(null)
    try {
      const delRes = await supabase.from('admin_emails').delete().eq('email', normalized)
      if (delRes.error) throw delRes.error

      // If they have an existing profile, demote to client (no access until
      // explicitly assigned). Their session keeps working until they refresh.
      const existing = profiles.find((p) => p.email.toLowerCase() === normalized)
      if (existing) {
        const upRes = await supabase
          .from('profiles')
          .update({ role: 'client' })
          .eq('id', existing.id)
        if (upRes.error) throw upRes.error
      }
      setAdminMsg(`${normalized} is no longer an admin.`)
      await load()
    } catch (e) {
      setAdminErr(e instanceof Error ? e.message : 'Failed to remove admin')
    } finally {
      setBusy(null)
    }
  }

  return (
    // Arkflow-owned page (not client-scoped): use the neutral Arkflow identity
    // (black / white / grey) instead of inheriting the default green brand.
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

          {/* top row: compact forms side by side */}
          <div style={topGrid}>
            {/* ── Admins ─────────────────────────────────────────────────── */}
            <div style={card}>
              <div style={cardHead}>Admins</div>

              {(() => {
                const adminEmailSet = new Set(adminEmails.map((a) => a.email.toLowerCase()))
                const internalProfiles = profiles.filter((p) => p.role === 'internal' && !p.disabled_at)
                const internalEmails = new Set(internalProfiles.map((p) => p.email.toLowerCase()))
                const pendingAdmins = adminEmails.filter((a) => !internalEmails.has(a.email.toLowerCase()))
                return (
                  <>
                    <div style={listBox}>
                      {internalProfiles.map((p) => {
                        const inAllowlist = adminEmailSet.has(p.email.toLowerCase())
                        const isSelf = p.email.toLowerCase() === meProfile?.email.toLowerCase()
                        return (
                          <div key={p.id} style={listRow}>
                            <div style={{ minWidth: 0 }}>
                              <div style={emailText}>{p.email}</div>
                              <div style={metaText}>
                                {isSelf ? 'You · ' : ''}{inAllowlist ? 'allowlisted' : 'internal (domain rule)'}
                              </div>
                            </div>
                            <Tooltip label={isSelf ? "You can't remove yourself" : 'Remove admin'}>
                              <button
                                onClick={() => void removeAdmin(p.email)}
                                disabled={isSelf || busy === `rm-admin:${p.email.toLowerCase()}`}
                                style={dangerLink}
                              >
                                Remove
                              </button>
                            </Tooltip>
                          </div>
                        )
                      })}

                      {pendingAdmins.map((a) => (
                        <div key={a.email} style={listRow}>
                          <div style={{ minWidth: 0 }}>
                            <div style={emailText}>{a.email}</div>
                            <div style={metaText}>allowlisted · awaiting first sign-in</div>
                          </div>
                          <button
                            onClick={() => void removeAdmin(a.email)}
                            disabled={busy === `rm-admin:${a.email.toLowerCase()}`}
                            style={dangerLink}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>

                    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                      <input
                        type="email"
                        placeholder="teammate@arkflow.ai"
                        value={newAdminEmail}
                        onChange={(e) => setNewAdminEmail(e.currentTarget.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void addAdmin() }}
                        style={{ ...inputStyle, flex: 1, minWidth: 0 }}
                      />
                      <button
                        type="button"
                        onClick={() => void addAdmin()}
                        disabled={busy === 'add-admin' || !newAdminEmail.trim()}
                        style={primaryBtnStyle}
                      >
                        {busy === 'add-admin' ? 'Adding…' : 'Add'}
                      </button>
                    </div>
                    {adminMsg ? <div style={okMsg}>{adminMsg}</div> : null}
                    {adminErr ? <div className="error-msg" style={{ marginTop: 8 }}>{adminErr}</div> : null}
                  </>
                )
              })()}
            </div>

            {/* ── Invite form ───────────────────────────────────────────── */}
            <div style={card}>
              <div style={cardHead}>Invite a client</div>
              <div style={{ display: 'grid', gap: 10 }}>
                <input
                  type="email"
                  placeholder="client-contact@company.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.currentTarget.value)}
                  style={inputStyle}
                />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => void inviteClient()}
                    disabled={busy === 'invite' || !inviteEmail.trim() || inviteClientIds.size === 0}
                    style={primaryBtnStyle}
                  >
                    {busy === 'invite' ? 'Sending…' : 'Send invite'}
                  </button>
                  {inviteMsg ? <div style={{ ...okMsg, marginTop: 0 }}>{inviteMsg}</div> : null}
                </div>
                {inviteErr ? <div className="error-msg">{inviteErr}</div> : null}
              </div>
            </div>
          </div>

          {/* ── Users (compact table) ──────────────────────────────────────── */}
          <div style={card}>
            <div style={cardHead}>Users ({profiles.length})</div>
            {usersMsg ? <div style={{ ...okMsg, marginTop: 0, marginBottom: 8 }}>{usersMsg}</div> : null}
            {usersErr ? <div className="error-msg" style={{ marginBottom: 8 }}>{usersErr}</div> : null}

            <div style={{ ...userRow, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
              <span style={colLabel}>User</span>
              <span style={colLabel}>Access</span>
              <span style={colLabel}>Can manage</span>
              <span />
            </div>

            {profiles.map((p) => {
              const assigned = new Set(clientsByUser.get(p.id) ?? [])
              const isInternal = p.role === 'internal'
              return (
                <div key={p.id} style={{ ...userRow, ...(p.disabled_at ? rowDisabled : null) }}>
                  <div style={{ minWidth: 0, ...(p.disabled_at ? dimmed : null) }}>
                    <div style={emailText}>{p.email}</div>
                    <div style={metaText}>
                      {p.full_name ? `${p.full_name} · ` : ''}{p.role}{p.disabled_at ? ' · disabled' : ''}
                    </div>
                  </div>

                  {isInternal ? (
                    <span style={{ ...metaText, gridColumn: '2 / 4', ...(p.disabled_at ? dimmed : null) }}>Internal — sees all clients</span>
                  ) : (
                    <>
                      <div style={{ ...pillWrap, ...(p.disabled_at ? dimmed : null) }}>
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

                      <div style={{ ...pillWrap, ...(p.disabled_at ? dimmed : null) }}>
                        {assigned.size > 0
                          ? clients.filter((c) => assigned.has(c.id)).map((c) => {
                              const isMgr = managerKeys.has(`${p.id}:${c.id}`)
                              const k = `mgr:${p.id}:${c.id}`
                              return (
                                <Tooltip
                                  key={c.id}
                                  label={isMgr ? 'Manager — can invite/revoke others for this client' : 'Make a members-manager for this client'}
                                >
                                  <button
                                    type="button"
                                    onClick={() => void setUserClientManage(p.id, c.id, !isMgr)}
                                    disabled={busy === k}
                                    style={{
                                      ...pillStyle,
                                      background: isMgr ? 'var(--text1)' : 'var(--white)',
                                      color: isMgr ? 'var(--white)' : 'var(--text2)',
                                    }}
                                  >
                                    {isMgr ? '★ ' : ''}{c.client_name?.trim() || `Client ${c.id}`}
                                  </button>
                                </Tooltip>
                              )
                            })
                          : <span style={metaText}>—</span>}
                      </div>
                    </>
                  )}

                  <div style={actionCell}>
                    {!p.disabled_at ? (
                      <Tooltip label="Email this user a fresh magic sign-in link">
                        <button
                          onClick={() => void resendLink(p.email, p.id)}
                          disabled={busy === `resend:${p.id}`}
                          style={subtleLink}
                        >
                          {busy === `resend:${p.id}` ? 'Sending…' : 'Resend link'}
                        </button>
                      </Tooltip>
                    ) : null}
                    <button
                      onClick={() => void toggleDisabled(p)}
                      disabled={busy === `disable:${p.id}` || p.id === meProfile?.id}
                      style={{ ...dangerLink, color: p.disabled_at ? 'var(--green)' : 'var(--red, #c33)' }}
                    >
                      {p.disabled_at ? 'Re-enable' : 'Disable'}
                    </button>
                    {p.id !== meProfile?.id ? (
                      confirmDel === p.id ? (
                        <span style={confirmRow}>
                          <Tooltip label="Permanently delete this user">
                            <button
                              onClick={() => void deleteUser(p)}
                              disabled={busy === `del:${p.id}`}
                              style={dangerLink}
                            >
                              {busy === `del:${p.id}` ? 'Deleting…' : 'Confirm'}
                            </button>
                          </Tooltip>
                          <button onClick={() => setConfirmDel(null)} style={subtleLink}>Cancel</button>
                        </span>
                      ) : (
                        <Tooltip label="Permanently delete this user">
                          <button
                            onClick={() => { setUsersMsg(null); setUsersErr(null); setConfirmDel(p.id) }}
                            style={dangerLink}
                          >
                            Delete
                          </button>
                        </Tooltip>
                      )
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>

          {/* ── Pending invites ────────────────────────────────────────────── */}
          {pending.length > 0 ? (
            <div style={card}>
              <div style={cardHead}>Pending invites ({Array.from(pendingByEmail.keys()).length})</div>
              <div style={listBox}>
                {Array.from(pendingByEmail.entries()).map(([email, cids]) => (
                  <div key={email} style={{ ...listRow, alignItems: 'center' }}>
                    <div style={{ ...emailText, flex: '0 0 auto' }}>{email}</div>
                    <div style={{ ...pillWrap, justifyContent: 'flex-end', flex: 1 }}>
                      {cids.map((cid) => (
                        <Tooltip key={cid} label="Click to revoke">
                          <button
                            onClick={() => void revokePending(email, cid)}
                            style={pillStyle}
                            disabled={busy === `pending:${email}:${cid}`}
                          >
                            {clientById.get(cid) ?? `Client ${cid}`} ✕
                          </button>
                        </Tooltip>
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

const topGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
  gap: 12,
  alignItems: 'start',
  marginTop: 14,
}

const card: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 14,
  background: 'var(--white)',
  marginTop: 12,
}

const cardHead: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: 0.8,
  textTransform: 'uppercase',
  color: 'var(--text3)',
  marginBottom: 10,
}

// Divided list (admins, pending) — rows separated by hairlines, no nested boxes.
const listBox: React.CSSProperties = { display: 'grid' }

const listRow: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 12,
  padding: '7px 0',
  borderBottom: '1px solid var(--border)',
}

const emailText: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 12.5,
  color: 'var(--text1)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const metaText: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10.5,
  color: 'var(--text4)',
  marginTop: 1,
}

const okMsg: React.CSSProperties = {
  marginTop: 8,
  color: 'var(--green)',
  fontSize: 11.5,
  fontFamily: 'var(--mono)',
}

// Users table: User | Access | Can manage | action.
// The action column is a fixed width (not `auto`) so the header row and data
// rows distribute the remaining fr-space identically and stay column-aligned.
const userRow: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(160px, 1.1fr) minmax(0, 1.7fr) minmax(0, 1.1fr) 116px',
  gap: 12,
  alignItems: 'center',
  padding: '9px 0',
  borderBottom: '1px solid var(--border)',
}

// Disabled users get a solid neutral grey band spanning the full row (negative
// inline margin bleeds it to the card's inner edges).
const rowDisabled: React.CSSProperties = {
  background: '#ececec',
  marginInline: -14,
  paddingInline: 14,
}

// Fades a disabled row's text/pills (applied to content cells only, so the grey
// band stays solid and the action button keeps its colour).
const dimmed: React.CSSProperties = {
  opacity: 0.45,
}

const colLabel: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  color: 'var(--text4)',
}

const pillWrap: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 5 }

const inputStyle: React.CSSProperties = {
  width: '100%',
  borderRadius: 9,
  border: '1px solid var(--border)',
  padding: '8px 11px',
  background: 'var(--white)',
  fontFamily: 'var(--mono)',
  fontSize: 12.5,
}

const pillStyle: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 999,
  padding: '3px 10px',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  cursor: 'pointer',
  background: 'var(--white)',
  color: 'var(--text2)',
  whiteSpace: 'nowrap',
}

const primaryBtnStyle: React.CSSProperties = {
  border: '1px solid var(--text1)',
  background: 'var(--text1)',
  color: 'var(--white)',
  borderRadius: 9,
  padding: '8px 14px',
  fontFamily: 'var(--mono)',
  fontSize: 12.5,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const dangerLink: React.CSSProperties = {
  border: 'none',
  background: 'none',
  padding: '2px 4px',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--red, #c33)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  justifySelf: 'end', // right-aligns within the users-grid action column (ignored in flex rows)
  textAlign: 'right',
}

// Right-aligned stack of row actions (Resend link + Disable/Re-enable + Delete).
const actionCell: React.CSSProperties = {
  justifySelf: 'end',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 3,
}

const confirmRow: React.CSSProperties = { display: 'flex', gap: 8 }

const subtleLink: React.CSSProperties = {
  border: 'none',
  background: 'none',
  padding: '2px 4px',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--text3)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  textAlign: 'right',
}
