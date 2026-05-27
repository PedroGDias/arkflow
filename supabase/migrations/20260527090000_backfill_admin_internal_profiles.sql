-- Backfill: guarantee every admin-allowlisted or @arkflow.ai auth user has an
-- enabled internal profile.
--
-- Why this is needed: the original "force-correct" inserts in
-- 20260526140000_seed_admin_emails.sql and 20260526180000_restore_strict_access.sql
-- ran exactly once, at migration time. Any qualifying user who signed up AFTER
-- those migrations — in particular during the window the auth trigger was
-- dropped (20260526160000_drop_trigger_and_diagnose.sql) — ended up with an
-- auth.users row but no public.profiles row. whoami() then returns nothing and
-- the app shows "This account doesn't have access yet" (e.g. info@arkflow.ai).
--
-- This re-runs the sync for the whole admin/domain set. It is idempotent and
-- safe to re-apply.

insert into public.profiles (id, email, full_name, role, disabled_at)
select
  u.id,
  lower(u.email),
  coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'),
  'internal',
  null
from auth.users u
where u.email is not null
  and (
    split_part(lower(u.email), '@', 2) = 'arkflow.ai'
    or exists (select 1 from public.admin_emails a where a.email = lower(u.email))
  )
on conflict (id) do update
  set role        = 'internal',
      disabled_at = null,
      email       = excluded.email;

-- Report resulting internal set so it's visible in the migration log.
do $$
declare rec record;
begin
  raise notice '-- internal profiles after backfill --';
  for rec in
    select email, role, disabled_at
    from public.profiles
    where role = 'internal'
    order by email
  loop
    raise notice 'profile email=% role=% disabled=%', rec.email, rec.role, rec.disabled_at;
  end loop;
end;
$$;
