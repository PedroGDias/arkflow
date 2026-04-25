-- Allow anon to update the manual cost-benchmark columns for client 1.
-- These are the fields edited in the audit / discovery section of the dashboard.

drop policy if exists "automations_update_costs_client_1_anon" on public.automations;
create policy "automations_update_costs_client_1_anon"
on public.automations
for update
to anon
using   (client_id = 1)
with check (client_id = 1);
