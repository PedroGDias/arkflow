-- Ensure new Client 1 automations (IDs 4-8) are marked Live.
-- Scope: ONLY client_id = 1 and ids 4..8.

update public.automations
set status = 'Live'
where client_id = 1
  and id in (4, 5, 6, 7, 8)
  and coalesce(status, '') <> 'Live';

