-- Ensure both anon + authenticated can SELECT julia_thread_stats_prod.
-- The dashboard runs with a logged-in session, so role is typically `authenticated`.

alter table public.julia_thread_stats_prod enable row level security;

grant select on table public.julia_thread_stats_prod to anon;
grant select on table public.julia_thread_stats_prod to authenticated;

drop policy if exists "julia_thread_stats_prod_select_anon" on public.julia_thread_stats_prod;
drop policy if exists "julia_thread_stats_prod_select_auth" on public.julia_thread_stats_prod;
drop policy if exists "julia_thread_stats_prod_select" on public.julia_thread_stats_prod;

create policy "julia_thread_stats_prod_select"
on public.julia_thread_stats_prod
for select
to anon, authenticated
using (true);

