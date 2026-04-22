import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { env } from '../lib/env'
import { supabase } from '../lib/supabase'
import { TEAM_MEMBERS } from '../lib/team'
import '../styles/dashboard.css'

type SkillStatus = { live: number; testing: number; offline: number }

const CLIENTS = [
  {
    id: env.clientId,
    name: 'Autocares Julia',
    industry: { EN: 'Transport & Tourism', ES: 'Transporte y Turismo' },
    logo: '/logos/android-chrome-192x192.png',
  },
]

export function ClientPickerPage() {
  const { signOut } = useAuth()
  const navigate = useNavigate()
  const [lang, setLang] = useState<'EN' | 'ES'>('EN')

  const activeWorkers = TEAM_MEMBERS.filter((m) => m.automationIds.length > 0).length
  const inactiveWorkers = TEAM_MEMBERS.length - activeWorkers

  // Skill status per client id
  const [skillStatus, setSkillStatus] = useState<Record<number, SkillStatus>>({})

  useEffect(() => {
    if (!supabase) return
    const sb = supabase

    Promise.all(
      CLIENTS.map(async (c) => {
        const { data } = await sb
          .from('automations')
          .select('id, status')
          .eq('client_id', c.id)
        const rows = (data ?? []) as Array<{ id: number; status: string | null }>
        const live = rows.filter((r) => (r.status ?? 'Live').toLowerCase() === 'live').length
        const testing = rows.filter((r) => (r.status ?? '').toLowerCase() === 'testing').length
        const offline = rows.length - live - testing
        return { id: c.id, status: { live, testing, offline } }
      }),
    ).then((results) => {
      const map: Record<number, SkillStatus> = {}
      for (const r of results) map[r.id] = r.status
      setSkillStatus(map)
    })
  }, [])


  return (
    <div className="page">
      <header className="header">
        <div className="wrap">
          <a className="logo" href="#">
            <img src="/logos/arkflow-logo.svg" alt="Arkflow" className="logo-img" />
          </a>
          <div className="header-r">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  display: 'inline-flex',
                  border: '1px solid var(--border)',
                  borderRadius: 999,
                  overflow: 'hidden',
                }}
              >
                <button
                  onClick={() => setLang('EN')}
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 11,
                    border: 0,
                    background: lang === 'EN' ? 'var(--text)' : 'var(--white)',
                    color: lang === 'EN' ? 'var(--white)' : 'var(--text2)',
                    padding: '6px 10px',
                    cursor: 'pointer',
                  }}
                >
                  EN
                </button>
                <button
                  onClick={() => setLang('ES')}
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 11,
                    border: 0,
                    background: lang === 'ES' ? 'var(--text)' : 'var(--white)',
                    color: lang === 'ES' ? 'var(--white)' : 'var(--text2)',
                    padding: '6px 10px',
                    cursor: 'pointer',
                  }}
                >
                  ES
                </button>
              </div>
              <button
                onClick={() => void signOut()}
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  border: '1px solid var(--border)',
                  background: 'var(--white)',
                  borderRadius: 999,
                  padding: '6px 12px',
                  cursor: 'pointer',
                }}
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

          <div className="client-grid">
            {CLIENTS.map((c) => {
              const ss = skillStatus[c.id]
              return (
                <button
                  key={c.id}
                  className="client-card"
                  onClick={() => navigate(`/client/${c.id}`)}
                >
                  <img src={c.logo} alt={c.name} className="client-card-logo" />
                  <div className="client-card-name">{c.name}</div>
                  <div className="client-card-industry">{c.industry[lang]}</div>

                  <div className="client-card-divider" />

                  <div className="client-card-meta">
                    {/* Workers — one named pill per member */}
                    <div className="client-card-meta-row">
                      <span className="client-card-meta-label">Workers</span>
                      <span className="client-card-meta-pills">
                        {activeWorkers > 0 && (
                          <span className="row-live live">
                            <span className="live-dot live" />
                            {activeWorkers} {lang === 'EN' ? 'active' : 'activos'}
                          </span>
                        )}
                        {inactiveWorkers > 0 && (
                          <span className="row-live offline">
                            <span className="live-dot offline" />
                            {inactiveWorkers} {lang === 'EN' ? 'inactive' : 'inactivos'}
                          </span>
                        )}
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
