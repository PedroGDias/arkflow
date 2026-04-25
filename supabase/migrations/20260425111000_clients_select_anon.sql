-- Allow anon to read client rows (needed for brand colour, name, and currency).
-- Mirrors the equivalent policy on public.automations.

alter table public.clients enable row level security;

drop policy if exists "clients_select_anon" on public.clients;
create policy "clients_select_anon"
on public.clients
for select
to anon
using (true);
