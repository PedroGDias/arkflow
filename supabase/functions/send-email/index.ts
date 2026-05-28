// Supabase Auth "Send Email" hook → sends auth emails via the Gmail API.
//
// When the hook is enabled (Dashboard → Authentication → Hooks, or
// [auth.hook.send_email] locally), Supabase Auth STOPS sending emails itself and
// POSTs the email payload here. This function:
//   1. Verifies the request really came from Supabase (Standard Webhooks sig).
//   2. Trades the long-lived Google refresh token for a short-lived access token.
//   3. Renders a branded email for the action type (magic link, invite, etc.).
//   4. Sends it with Gmail API users.messages.send.
//
// Secrets (set with `supabase secrets set …`, NEVER hard-coded / committed):
//   GOOGLE_CLIENT_ID       OAuth client id
//   GOOGLE_CLIENT_SECRET   OAuth client secret
//   GOOGLE_REFRESH_TOKEN   refresh token minted for THIS client (scope gmail.send)
//   GMAIL_SENDER           From address — the Gmail account or a verified alias
//   SEND_EMAIL_HOOK_SECRET the secret Supabase shows when you create the hook
//                          (format: "v1,whsec_…")
//
// SUPABASE_URL is injected automatically by the edge runtime.

import { Webhook } from 'https://esm.sh/standardwebhooks@1.0.0'

const FROM_NAME = 'Arkflow'

type EmailActionType =
  | 'signup'
  | 'magiclink'
  | 'recovery'
  | 'invite'
  | 'email_change'
  | 'email_change_current'
  | 'email_change_new'
  | string

interface HookPayload {
  user: { id: string; email: string }
  email_data: {
    token: string
    token_hash: string
    redirect_to: string
    email_action_type: EmailActionType
    site_url: string
    token_new?: string
    token_hash_new?: string
  }
}

// Per-action copy. Anything not listed falls back to a generic sign-in mail.
const COPY: Record<string, { subject: string; cta: string; lead: string }> = {
  magiclink: {
    subject: 'Sign in to Arkflow',
    cta: 'Sign in to Arkflow',
    lead: 'Click below to sign in to your Arkflow dashboard. This link works once and expires shortly.',
  },
  signup: {
    subject: 'Confirm your Arkflow account',
    cta: 'Confirm my email',
    lead: 'Welcome to Arkflow. Confirm your email to activate your account and open your dashboard.',
  },
  invite: {
    subject: "You've been invited to Arkflow",
    cta: 'Accept invitation',
    lead: "You've been invited to view an Arkflow dashboard. Accept the invitation to set up access.",
  },
  recovery: {
    subject: 'Reset your Arkflow password',
    cta: 'Reset password',
    lead: 'Click below to choose a new password for your Arkflow account.',
  },
  email_change: {
    subject: 'Confirm your new email · Arkflow',
    cta: 'Confirm email',
    lead: 'Confirm this address to update the email on your Arkflow account.',
  },
}

function copyFor(type: EmailActionType) {
  return (
    COPY[type] ?? {
      subject: 'Arkflow',
      cta: 'Continue',
      lead: 'Click below to continue to Arkflow.',
    }
  )
}

// GoTrue verifies links at <project>/auth/v1/verify; it then 302s to redirect_to.
function buildVerifyUrl(supabaseUrl: string, d: HookPayload['email_data']) {
  const params = new URLSearchParams({
    token: d.token_hash,
    type: d.email_action_type,
    redirect_to: d.redirect_to || d.site_url,
  })
  return `${supabaseUrl}/auth/v1/verify?${params.toString()}`
}

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
const SERIF = "Georgia,'Times New Roman',serif"

function renderHtml(args: { lead: string; cta: string; url: string }) {
  const { lead, cta, url } = args
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#ffffff;">
    <div style="font-family:${SANS};max-width:480px;margin:0 auto;padding:32px 24px;color:#1a1a1a;">
      <div style="font-family:${SERIF};font-size:24px;margin-bottom:10px;">Arkflow</div>
      <p style="font-size:15px;line-height:1.6;color:#555;margin:0 0 8px;">${lead}</p>
      <p style="margin:28px 0;">
        <a href="${url}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;font-weight:500;">${cta}</a>
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

function toBase64Url(input: string) {
  return toBase64(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// RFC 2047 encoded-word so non-ASCII subject chars (e.g. "·") aren't mangled.
function encodeSubject(subject: string) {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(subject) ? subject : `=?UTF-8?B?${toBase64(subject)}?=`
}

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
  const json = await res.json()
  if (!res.ok || !json.access_token) {
    throw new Error(`Google token exchange failed: ${json.error ?? res.status} ${json.error_description ?? ''}`)
  }
  return json.access_token as string
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
  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`Gmail send failed (${res.status}): ${detail}`)
  }
}

// Hook error contract: return a JSON body with { error: { http_code, message } }.
function errorResponse(status: number, message: string) {
  return new Response(JSON.stringify({ error: { http_code: status, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return errorResponse(405, 'Method not allowed')

  const payload = await req.text()
  const hookSecret = Deno.env.get('SEND_EMAIL_HOOK_SECRET')

  let body: HookPayload
  try {
    if (hookSecret) {
      const wh = new Webhook(hookSecret.replace('v1,whsec_', ''))
      body = wh.verify(payload, Object.fromEntries(req.headers)) as HookPayload
    } else {
      // No secret configured — accept unverified (only sensible for local dev).
      body = JSON.parse(payload) as HookPayload
    }
  } catch (_e) {
    return errorResponse(401, 'Invalid webhook signature')
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? body.email_data.site_url
    const c = copyFor(body.email_data.email_action_type)
    const url = buildVerifyUrl(supabaseUrl, body.email_data)
    const html = renderHtml({ lead: c.lead, cta: c.cta, url })
    await sendGmail(body.user.email, c.subject, html)
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to send email'
    console.error('[send-email]', message)
    return errorResponse(500, message)
  }
})
