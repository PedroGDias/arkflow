-- Extend cost-column UPDATE access to authenticated users (Google OAuth sessions).
-- The existing policy only covered the anon role; logged-in users need the same.

drop policy if exists "automations_update_costs_authenticated" on public.automations;
create policy "automations_update_costs_authenticated"
on public.automations
for update
to authenticated
using   (true)
with check (true);

-- Also ensure authenticated users can SELECT automations (mirrors the anon policy).
drop policy if exists "automations_select_authenticated" on public.automations;
create policy "automations_select_authenticated"
on public.automations
for select
to authenticated
using (true);
