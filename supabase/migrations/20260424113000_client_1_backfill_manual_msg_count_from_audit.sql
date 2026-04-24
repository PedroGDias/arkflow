-- Backfill manual sample size as total message count into `public.automations` for client 1.
--
-- This migration changes the interpretation of `automations.manual_sample_size` to mean:
--   total number of messages in the manual audit sample (sum of `nr_msgs`)
-- rather than number of conversations/rows.
--
-- Rules:
-- - Quote-request automations: discard audit entries after 14 Apr 2026 (UTC).

with quote_autos as (
  select a.id
  from public.automations a
  where a.client_id = 1
    and (
      coalesce(a.automation_name, '') ilike '%quote%'
      or coalesce(a.automation_name_local, '') ilike '%quote%'
      or coalesce(a.automation_name, '') ilike '%presupuesto%'
      or coalesce(a.automation_name_local, '') ilike '%presupuesto%'
    )
),
audit_scoped as (
  select
    e.automation_id,
    e.created_at,
    greatest(coalesce(e.nr_msgs, 0), 0)::bigint as nr_msgs
  from public.audit_julia_emails e
  join public.automations a on a.id = e.automation_id
  where a.client_id = 1
    and (
      e.automation_id not in (select id from quote_autos)
      or e.created_at < timestamptz '2026-04-15 00:00:00+00'
    )
),
agg as (
  select
    automation_id,
    sum(nr_msgs)::bigint as manual_msg_count
  from audit_scoped
  group by automation_id
)
update public.automations a
set manual_sample_size = coalesce(agg.manual_msg_count, 0)
from agg
where a.client_id = 1
  and a.id = agg.automation_id;

