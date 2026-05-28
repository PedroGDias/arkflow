-- Per-email cooldown for the public `auth-link` edge function, which sends
-- magic sign-in links via Gmail (bypassing GoTrue's email rate limit). Written
-- only by the edge function via the service role — no client access needed.

create table if not exists public.auth_link_throttle (
  email        text primary key,
  last_sent_at timestamptz not null default now()
);

alter table public.auth_link_throttle enable row level security;
-- Intentionally no policies: the service role bypasses RLS; no one else should
-- read or write this table.
