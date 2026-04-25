-- Replace the client_1-specific UPDATE policy with one that covers any client,
-- since client_id is determined at query time by the app and there is no auth session
-- to derive it from inside the policy.

drop policy if exists "automations_update_costs_client_1_anon" on public.automations;
drop policy if exists "automations_update_costs_anon"           on public.automations;

create policy "automations_update_costs_anon"
on public.automations
for update
to anon
using   (true)
with check (true);
