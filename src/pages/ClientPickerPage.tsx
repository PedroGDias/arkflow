import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { env } from '../lib/env'
import { supabase } from '../lib/supabase'
import type { Client } from '../lib/types'
import { clientLogoUrl } from '../lib/clientLogos'
import '../styles/dashboard.css'

type SkillStatus = { live: number; testing: number; offline: number }
type WorkerStatus = { live: number; testing: number; offline: number }

function statusLower(status: unknown) {
  return (status ?? '').toString().trim().toLowerCase()
}

type ClientRow = Pick<Client, 'id' | 'client_name' | 'logo_path'>

export function ClientPickerPage() {
  const { signOut } = useAuth()
  const navigate = useNavigate()
  const [lang, setLang] = useState<'EN' | 'ES'>('EN')

  useEffect(() => {
    document.title = 'Clients · Arkflow'
  }, [])

  const [clients, setClients] = useState<ClientRow[]>([])
  const [clientsError, setClientsError] = useState<string | null>(null)

  // Skill status per client id
  const [skillStatus, setSkillStatus] = useState<Record<number, SkillStatus>>({})
  const [workerStatus, setWorkerStatus] = useState<Record<number, WorkerStatus>>({})

  useEffect(() => {
    if (!supabase) return
    const sb = supabase

    ;(async () => {
      // Backwards-compatible fetch: older DBs may not have clients.logo_path yet.
      const resWithLogo = await sb
        .from('clients')
        .select('id,client_name,logo_path')
        .order('id', { ascending: true })

      if (!resWithLogo.error) {
        setClientsError(null)
        setClients((resWithLogo.data ?? []) as ClientRow[])
        return
      }

      const msg = resWithLogo.error.message || ''
      const missingLogoPath =
        msg.includes('logo_path') && (msg.includes('does not exist') || msg.includes('column') || msg.includes('schema'))

      if (!missingLogoPath) {
        setClientsError(resWithLogo.error.message)
        setClients([])
        return
      }

      const resNoLogo = await sb
        .from('clients')
        .select('id,client_name')
        .order('id', { ascending: true })

      if (resNoLogo.error) {
        setClientsError(resNoLogo.error.message)
        setClients([])
        return
      }

      setClientsError(null)
      setClients(((resNoLogo.data ?? []) as Array<Pick<Client, 'id' | 'client_name'>>).map((c) => ({ ...c, logo_path: null })))
    })()
  }, [])

  useEffect(() => {
    if (!supabase) return
    const sb = supabase
    if (clients.length === 0) return

    Promise.all(
      clients.map(async (c) => {
        const { data } = await sb
          .from('automations')
          .select('id, status')
          .eq('client_id', c.id)
        const rows = (data ?? []) as Array<{ id: number; status: string | null }>
        const nonDiscovery = rows.filter((r) => statusLower(r.status ?? 'Live') !== 'discovery')
        const live = nonDiscovery.filter((r) => statusLower(r.status ?? 'Live') === 'live').length
        const testing = nonDiscovery.filter((r) => statusLower(r.status ?? '') === 'testing').length
        const offline = nonDiscovery.length - live - testing

        // Workers are derived from real rows: team members assigned to this client.
        // Their status is based on the status of automations assigned to them (same logic as DashboardPage):
        // - live if any assigned automation is Live
        // - testing if any is Testing and none are Live
        // - offline otherwise
        const memberIdsRes = await sb
          .from('team_members_clients')
          .select('team_member_id')
          .eq('client_id', c.id)
        const memberIds = ((memberIdsRes.data ?? []) as Array<{ team_member_id: number }>).map((r) => r.team_member_id)

        if (memberIds.length === 0) {
          return { id: c.id, skill: { live, testing, offline }, workers: { live: 0, testing: 0, offline: 0 } }
        }

        const [assignRes, autosRes] = await Promise.all([
          sb
            .from('team_members_automations')
            .select('team_member_id,automation_id')
            .in('team_member_id', memberIds),
          sb.from('automations').select('id,status').eq('client_id', c.id),
        ])

        const statusByAutoId = new Map<number, string>()
        for (const a of (autosRes.data ?? []) as Array<{ id: number; status: string | null }>) {
          statusByAutoId.set(a.id, statusLower(a.status ?? ''))
        }

        const autoIdsByMember = new Map<number, number[]>()
        for (const row of (assignRes.data ?? []) as Array<{ team_member_id: number; automation_id: number }>) {
          const list = autoIdsByMember.get(row.team_member_id) ?? []
          list.push(row.automation_id)
          autoIdsByMember.set(row.team_member_id, list)
        }

        let wLive = 0
        let wTesting = 0
        let wOffline = 0
        for (const mid of memberIds) {
          const ids = autoIdsByMember.get(mid) ?? []
          const st = ids.map((id) => statusByAutoId.get(id) ?? '')
          const hasLive = st.some((s) => s === 'live')
          const hasTesting = st.some((s) => s === 'testing')
          if (hasLive) wLive++
          else if (hasTesting) wTesting++
          else wOffline++
        }

        return { id: c.id, skill: { live, testing, offline }, workers: { live: wLive, testing: wTesting, offline: wOffline } }
      }),
    ).then((results) => {
      const map: Record<number, SkillStatus> = {}
      const wmap: Record<number, WorkerStatus> = {}
      for (const r of results) {
        map[r.id] = r.skill
        wmap[r.id] = r.workers
      }
      setSkillStatus(map)
      setWorkerStatus(wmap)
    })
  }, [clients])

  return (
    <div className="page">
      <header className="header">
        <div className="wrap">
          <a className="logo" href="#">
            <img src="/logos/arkflow-logo.svg" alt="Arkflow" className="logo-img" />
          </a>
          <div className="header-r">
            <div className="header-ctls">
              <div className="hdr-seg">
                <button
                  onClick={() => setLang('EN')}
                  className={`hdr-seg-btn ${lang === 'EN' ? 'active' : ''}`}
                >
                  EN
                </button>
                <button
                  onClick={() => setLang('ES')}
                  className={`hdr-seg-btn ${lang === 'ES' ? 'active' : ''}`}
                >
                  ES
                </button>
              </div>
              <button
                onClick={() => void signOut()}
                className="hdr-ctl hdr-btn"
              >
                {lang === 'EN' ? 'Sign out' : 'Cerrar sesión'}
              </button>
            </div>
          </div>
        </div>
      </header>

      <section className="topbar picker-topbar">
        <div className="wrap">
          <div className="topbar-label">
            {lang === 'EN' ? 'Arkflow Dashboard' : 'Panel Arkflow'}
          </div>
          <h1>{lang === 'EN' ? 'Your clients' : 'Tus clientes'}</h1>
          {clientsError && (
            <div style={{ marginTop: 8, color: 'var(--red)' }}>
              {lang === 'EN' ? 'Failed to load clients:' : 'Error cargando clientes:'} {clientsError}
            </div>
          )}

          <div className="client-grid">
            {clients.map((c) => {
              const ss = skillStatus[c.id]
              const ws = workerStatus[c.id]
              const name = c.client_name?.trim() || `Client ${c.id}`
              return (
                <button
                  key={c.id}
                  className="client-card"
                  onClick={() => navigate(`/client/${c.id}`)}
                >
                  <img src={clientLogoUrl(c.logo_path)} alt={name} className="client-card-logo" />
                  <div className="client-card-name">{name}</div>
                  <div className="client-card-industry">{lang === 'EN' ? 'Client' : 'Cliente'}</div>

                  <div className="client-card-divider" />

                  <div className="client-card-meta">
                    {/* Workers — one named pill per member */}
                    <div className="client-card-meta-row">
                      <span className="client-card-meta-label">Workers</span>
                      <span className="client-card-meta-pills">
                        {ws != null && ws.live > 0 && (
                          <span className="row-live live">
                            <span className="live-dot live" />
                            {ws.live} {lang === 'EN' ? 'active' : 'activos'}
                          </span>
                        )}
                        {ws != null && ws.testing > 0 && (
                          <span className="row-live testing">
                            <span className="live-dot testing" />
                            {ws.testing} {lang === 'EN' ? 'testing' : 'en pruebas'}
                          </span>
                        )}
                        {ws != null && ws.offline > 0 && (
                          <span className="row-live offline">
                            <span className="live-dot offline" />
                            {ws.offline} {lang === 'EN' ? 'inactive' : 'inactivos'}
                          </span>
                        )}
                        {ws == null && <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text4)' }}>–</span>}
                      </span>
                    </div>

                    {/* Skills */}
                    <div className="client-card-meta-row">
                      <span className="client-card-meta-label">Skills</span>
                      <span className="client-card-meta-pills">
                        {ss == null && <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text4)' }}>–</span>}
                        {ss != null && ss.live > 0 && (
                          <span className="row-live live">
                            <span className="live-dot live" />
                            {ss.live} {lang === 'EN' ? 'active' : 'activas'}
                          </span>
                        )}
                        {ss != null && ss.testing > 0 && (
                          <span className="row-live testing">
                            <span className="live-dot testing" />
                            {ss.testing} {lang === 'EN' ? 'testing' : 'en pruebas'}
                          </span>
                        )}
                        {ss != null && ss.offline > 0 && (
                          <span className="row-live offline">
                            <span className="live-dot offline" />
                            {ss.offline} {lang === 'EN' ? 'inactive' : 'inactivas'}
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </section>

      <footer className="footer">
        <div className="wrap">
          <a href="#">Arkflow</a> · {lang === 'EN' ? 'AI workers that do the work' : 'IA que trabaja por ti'}
        </div>
      </footer>
    </div>
  )
}
