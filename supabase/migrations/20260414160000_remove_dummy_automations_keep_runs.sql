-- Remove dummy automations from the client dashboard.
--
-- We keep ONLY the real Quote Request automation, matched by name.
-- This avoids relying on run history, since dummy runs may exist.
--
-- IMPORTANT: We do not delete or update any `public.runs` rows.
--
-- If your canonical name differs, update the `keep` CTE predicate.

with keep as (
  select id
  from public.automations
  where client_id = 1
    and (
      automation_name ilike '%quote%'
      or automation_name ilike '%presupuesto%'
    )
  limit 1
)
delete from public.automations a
where a.client_id = 1
  and exists (select 1 from keep)
  and a.id <> (select id from keep);

