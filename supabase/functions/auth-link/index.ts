// Public endpoint the login page calls to request a magic sign-in link.
//
// Why this exists: Supabase locks the auth-email rate limit at the project
// default (2/hr) unless Custom SMTP is enabled, and that throttle is enforced
// *before* the Send Email hook runs — so the Gmail hook alone can't get past
// it. This endpoint sidesteps GoTrue's email path entirely: it generates the
// link with the admin API (admin.generateLink sends NO email and is not
// subject to the email rate limit) and then sends it via Gmail ourselves.
//
// Abuse guards (this endpoint is unauthenticated):
//   • only sends to an existing, enabled profile (no enumeration, no arbitrary
//     recipients)
//   • per-email cooldown via public.auth_link_throttle
//
// Secrets (supabase secrets set …):
//   SUPABASE_SERVICE_ROLE_KEY   admin key — generate links + read profiles
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

function renderHtml(url: string) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#ffffff;">
    <div style="font-family:${SANS};max-width:480px;margin:0 auto;padding:32px 24px;color:#1a1a1a;">
      <div style="font-family:${SERIF};font-size:24px;margin-bottom:10px;">Arkflow</div>
      <p style="font-size:15px;line-height:1.6;color:#555;margin:0 0 8px;">Click below to sign in to your Arkflow dashboard. This link works once and expires shortly.</p>
      <p style="margin:28px 0;">
        <a href="${url}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;font-weight:500;">Sign in to Arkflow</a>
      </p>
      <p style="font-size:12px;color:#aaa;margin-top:28px;">If you didn't request this, you can safely ignore this email.</p>
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

  // Always answer 200 {ok:true} from here on, regardless of outcome, so the
  // endpoint can't be used to probe which emails have accounts.
  try {
    // 1. Only known, enabled users get a link.
    const { data: profile } = await admin
      .from('profiles')
      .select('id, disabled_at')
      .ilike('email', email)
      .maybeSingle()
    if (!profile || profile.disabled_at) return json({ ok: true })

    // 2. Per-email cooldown.
    const { data: t } = await admin
      .from('auth_link_throttle')
      .select('last_sent_at')
      .eq('email', email)
      .maybeSingle()
    if (t && Date.now() - new Date(t.last_sent_at).getTime() < COOLDOWN_MS) {
      return json({ ok: true })
    }

    // 3. Generate the magic link WITHOUT sending email (no rate limit).
    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: redirectTo || `${supabaseUrl}/auth/callback` },
    })
    if (linkErr || !link?.properties?.action_link) {
      console.error('[auth-link] generateLink failed', linkErr)
      return json({ ok: true })
    }

    // 4. Send it ourselves via Gmail, then record the cooldown.
    await sendGmail(email, 'Sign in to Arkflow', renderHtml(link.properties.action_link))
    await admin.from('auth_link_throttle').upsert({ email, last_sent_at: new Date().toISOString() })
    return json({ ok: true })
  } catch (e) {
    console.error('[auth-link]', e instanceof Error ? e.message : e)
    return json({ ok: true })
  }
})
