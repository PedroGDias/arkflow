-- All existing auth.users predate the client-access feature — they were
-- previously gated only by the @arkflow.ai email allowlist in the frontend.
-- So any row present in auth.users at this point belongs to the Arkflow team
-- and should be a fully enabled internal user.
--
-- This migration force-syncs every existing auth.users into profiles as
-- internal/enabled, regardless of email domain. It also RAISES NOTICE with
-- the resulting counts so we can see in the migration log what landed.

insert into public.profiles (id, email, full_name, role, disabled_at)
select
  u.id,
  lower(u.email),
  coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'),
  'internal',
  null
from auth.users u
where u.email is not null
on conflict (id) do update
set role        = 'internal',
    disabled_at = null,
    email       = excluded.email;

do $$
declare
  v_auth_count    bigint;
  v_profile_count bigint;
  v_internal      bigint;
  v_disabled      bigint;
begin
  select count(*) into v_auth_count    from auth.users;
  select count(*) into v_profile_count from public.profiles;
  select count(*) into v_internal      from public.profiles where role='internal' and disabled_at is null;
  select count(*) into v_disabled      from public.profiles where disabled_at is not null;
  raise notice 'promote_all_existing: auth.users=%, profiles=%, internal_enabled=%, disabled=%',
    v_auth_count, v_profile_count, v_internal, v_disabled;
end;
$$;
