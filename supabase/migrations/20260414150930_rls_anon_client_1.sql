-- Allow anon reads for client dashboard (client_id = 1)
-- This is temporary to unblock the live ROI dashboard.

alter table public.automations enable row level security;
alter table public.runs enable row level security;

drop policy if exists "automations_select_client_1_anon" on public.automations;
create policy "automations_select_client_1_anon"
on public.automations
for select
to anon
using (client_id = 1);

drop policy if exists "runs_select_client_1_anon" on public.runs;
create policy "runs_select_client_1_anon"
on public.runs
for select
to anon
using (
  exists (
    select 1
    from public.automations a
    where a.id = runs.automation_id
      and a.client_id = 1
  )
);

