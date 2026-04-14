-- Allow anon reads for julia_thread_stats so the dashboard can show
-- total conversations and % finished.
--
-- This mirrors the temporary dashboard policies for `automations` and `runs`.
-- If you later add client scoping (e.g. client_id), replace `using (true)`
-- with a client filter and remove the broad grant.

alter table public.julia_thread_stats enable row level security;

grant select on table public.julia_thread_stats to anon;
grant select on table public.julia_thread_stats to authenticated;

drop policy if exists "julia_thread_stats_select_anon" on public.julia_thread_stats;
create policy "julia_thread_stats_select_anon"
on public.julia_thread_stats
for select
to anon
using (true);

