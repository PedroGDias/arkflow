-- Add preferred display currency to clients.
-- Defaults to EUR to match the existing hardcoded behaviour.

alter table public.clients
  add column if not exists currency text default 'EUR';
