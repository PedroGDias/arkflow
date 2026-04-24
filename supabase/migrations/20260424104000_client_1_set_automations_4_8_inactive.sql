-- Mark new Client 1 automations (IDs 4-8) as Inactive.
-- Scope: ONLY client_id = 1 and ids 4..8.
--
-- Note: In the dashboard, only status 'Live' and 'Testing' are treated as active states.

update public.automations
set status = 'Inactive'
where client_id = 1
  and id in (4, 5, 6, 7, 8)
  and coalesce(status, '') <> 'Inactive';

