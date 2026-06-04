// Issues a random password for a user and emails it. This replaces magic links,
// which corporate mail security (Microsoft Safe Links, Mimecast, …) auto-clicks
// and consumes before the user can — a password in an email is not a clickable
// one-time token, so a scanner reading it can't burn it.
//
// Two modes, decided by the caller's Authorization header:
//   • admin — the header carries an internal admin's JWT. May target ANY email
//             and CREATES the account if it doesn't exist. Used by the admin
//             "invite" and "reset password" actions. Returns real errors.
//   • self  — unauthenticated. Throttled, only for existing + enabled users,
//             never creates accounts, always answers 200 {ok:true} so it can't
//             be used to enumerate accounts. Used by login "forgot password".
//
// The new password is emailed to the user — never returned in the response.
//
// Secrets (supabase secrets set …):
//   SUPABASE_SERVICE_ROLE_KEY   admin key — set passwords, read profiles
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN / GMAIL_SENDER
// SUPABASE_URL is injected by the edge runtime.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.0'

const FROM_NAME = 'Arkflow'
const COOLDOWN_MS = 60_000
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
const SERIF = "Georgia,'Times New Roman',serif"

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

// 18 random bytes → base64url (~24 chars): strong, no ambiguous padding chars.
function genPassword() {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function renderHtml(args: { password: string; loginUrl: string }) {
  const { password, loginUrl } = args
  const cta = loginUrl
    ? `<p style="margin:28px 0;"><a href="${loginUrl}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;font-weight:500;">Open Arkflow</a></p>`
    : ''
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#ffffff;">
    <div style="font-family:${SANS};max-width:480px;margin:0 auto;padding:32px 24px;color:#1a1a1a;">
      <div style="font-family:${SERIF};font-size:24px;margin-bottom:10px;">Arkflow</div>
      <p style="font-size:15px;line-height:1.6;color:#555;margin:0 0 16px;">Here is your password for the Arkflow dashboard. Sign in with your email address and this password:</p>
      <p style="font-family:'SF Mono',Consolas,monospace;font-size:20px;letter-spacing:0.5px;background:#f4f4f2;border:1px solid #e5e2da;border-radius:8px;padding:14px 16px;margin:0 0 16px;word-break:break-all;">${password}</p>
      <p style="font-size:13px;line-height:1.6;color:#888;margin:0 0 8px;">For your security, change it after signing in from your account menu.</p>
      ${cta}
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
      <p style="font-size:12px;color:#aaa;margin:0;">Arkflow · AI workers that do the work</p>
    </div>
  </body>
</html>`
}

function toBase64(input: string) {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}
const toBase64Url = (s: string) => toBase64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const encodeSubject = (s: string) =>
  // eslint-disable-next-line no-control-regex
  /^[\x00-\x7F]*$/.test(s) ? s : `=?UTF-8?B?${toBase64(s)}?=`

async function getAccessToken(): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
      client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '',
      refresh_token: Deno.env.get('GOOGLE_REFRESH_TOKEN') ?? '',
      grant_type: 'refresh_token',
    }),
  })
  const j = await res.json()
  if (!res.ok || !j.access_token) throw new Error(`Google token exchange failed: ${j.error ?? res.status}`)
  return j.access_token as string
}

async function sendGmail(to: string, subject: string, html: string) {
  const sender = Deno.env.get('GMAIL_SENDER') ?? ''
  const accessToken = await getAccessToken()
  const mime = [
    `From: ${FROM_NAME} <${sender}>`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
  ].join('\r\n')
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: toBase64Url(mime) }),
  })
  if (!res.ok) throw new Error(`Gmail send failed (${res.status}): ${await res.text()}`)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  let email = ''
  let redirectTo = ''
  try {
    const body = await req.json()
    email = (body.email ?? '').toString().trim().toLowerCase()
    redirectTo = (body.redirect_to ?? '').toString()
  } catch {
    return json({ error: 'bad_request' }, 400)
  }
  if (!email || !email.includes('@')) return json({ error: 'invalid_email' }, 400)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  // Decide mode: a valid internal-admin JWT in the Authorization header unlocks
  // admin mode. Anything else (anon key, no header) falls through to self-serve.
  let isAdmin = false
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (token) {
    const { data: u } = await admin.auth.getUser(token)
    if (u?.user) {
      const { data: prof } = await admin
        .from('profiles')
        .select('role, disabled_at')
        .eq('id', u.user.id)
        .maybeSingle()
      if (prof && prof.role === 'internal' && !prof.disabled_at) isAdmin = true
    }
  }

  const { data: target } = await admin
    .from('profiles')
    .select('id, disabled_at')
    .ilike('email', email)
    .maybeSingle()

  // Self-serve guards: existing+enabled only, throttled, never reveal outcome.
  if (!isAdmin) {
    if (!target || target.disabled_at) return json({ ok: true })
    const { data: t } = await admin
      .from('auth_link_throttle')
      .select('last_sent_at')
      .eq('email', email)
      .maybeSingle()
    if (t && Date.now() - new Date(t.last_sent_at).getTime() < COOLDOWN_MS) return json({ ok: true })
  }

  const password = genPassword()
  try {
    if (target?.id) {
      const { error } = await admin.auth.admin.updateUserById(target.id, { password })
      if (error) throw error
    } else {
      // Only admins can provision a brand-new account. The handle_new_user
      // trigger then creates the profile and consumes any pending_invites.
      if (!isAdmin) return json({ ok: true })
      const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
      if (error) throw error
    }

    const origin = redirectTo ? new URL(redirectTo).origin : ''
    await sendGmail(email, 'Your Arkflow password', renderHtml({ password, loginUrl: origin ? `${origin}/login` : '' }))
    await admin.from('auth_link_throttle').upsert({ email, last_sent_at: new Date().toISOString() })
    return json({ ok: true })
  } catch (e) {
    console.error('[issue-password]', e instanceof Error ? e.message : e)
    // Admins get the real error so the UI can show it; self-serve stays opaque.
    return isAdmin ? json({ error: e instanceof Error ? e.message : 'failed' }, 500) : json({ ok: true })
  }
})
