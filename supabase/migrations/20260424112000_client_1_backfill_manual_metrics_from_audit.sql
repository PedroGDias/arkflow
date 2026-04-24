-- Backfill manual benchmark metrics into `public.automations` for client 1.
--
-- Rules:
-- 1) Quote-request automations: discard audit entries after 14 Apr 2026 (UTC).
-- 2) For avg response time: ignore rows with avg_resp_time = -1 (exclude from numerator + denominator).
-- 3) Weighted avg response time: weight each audit row by message *pairs* (floor(nr_msgs / 2)).
--    Examples: nr_msgs=3 => weight=1, nr_msgs=7 => weight=3.
--
-- Targets:
-- - manual_sample_size: count of audit rows considered (after quote cutoff).
-- - manual_avg_response_time: weighted average seconds (bigint), NULL if no valid weights.

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
    e.nr_msgs,
    e.avg_resp_time,
    case
      when e.nr_msgs is null or e.nr_msgs <= 0 then 0
      else floor((e.nr_msgs::numeric) / 2)::bigint
    end as weight_pairs
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
    count(*)::bigint as manual_sample_size,
    sum(weight_pairs) filter (where avg_resp_time <> -1 and weight_pairs > 0) as denom_pairs,
    sum((avg_resp_time::numeric) * (weight_pairs::numeric)) filter (where avg_resp_time <> -1 and weight_pairs > 0) as numer_weighted
  from audit_scoped
  group by automation_id
),
final as (
  select
    a.id as automation_id,
    coalesce(agg.manual_sample_size, 0)::bigint as manual_sample_size,
    case
      when coalesce(agg.denom_pairs, 0) > 0
        then round(agg.numer_weighted / agg.denom_pairs)::bigint
      else null
    end as manual_avg_response_time
  from public.automations a
  left join agg on agg.automation_id = a.id
  where a.client_id = 1
)
update public.automations a
set
  manual_sample_size = f.manual_sample_size,
  manual_avg_response_time = f.manual_avg_response_time
from final f
where a.client_id = 1
  and a.id = f.automation_id;

