-- Andorra (a city under the "Quote Request" task for Autocares Julia / client 1)
-- was still flagged 'Testing' but is live in production. Flip it to Live.
-- Reported by JJ. Idempotent: only touches non-live Andorra rows for client 1.

do $$
declare
  v_count int;
  rec     record;
begin
  update public.automations
  set status = 'Live'
  where client_id = 1
    and lower(coalesce(status, '')) <> 'live'
    and (
      coalesce(automation_name, '')       ilike '%andorra%'
      or coalesce(automation_name_local, '') ilike '%andorra%'
    );
  get diagnostics v_count = row_count;
  raise notice 'Andorra -> Live: % row(s) updated', v_count;

  for rec in
    select id, coalesce(automation_name, automation_name_local) as name, status
    from public.automations
    where client_id = 1
      and (coalesce(automation_name, '') ilike '%andorra%'
        or coalesce(automation_name_local, '') ilike '%andorra%')
  loop
    raise notice '  id=% name=% status=%', rec.id, rec.name, rec.status;
  end loop;
end $$;
