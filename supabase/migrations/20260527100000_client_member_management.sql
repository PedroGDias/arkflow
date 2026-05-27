-- Delegated client access management.
--
-- Internal admins can designate per-client "managers" (client_users.can_manage).
-- A manager can invite / revoke OTHER users' access to the specific client(s)
-- they manage — and nothing else. Every mutation goes through a SECURITY
-- DEFINER RPC that authorizes against can_manage_client(), so a manager can
-- never: touch a client they don't manage, grant internal/admin access,
-- change roles, promote other managers, or disable accounts.

-- ── 1. Manager flag on the access mapping ──────────────────────────────────
alter table public.client_users
  add column if not exists can_manage boolean not null default false;

-- ── 2. Authorization helper ────────────────────────────────────────────────
create or replace function public.can_manage_client(p_client_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.disabled_at is null
      and (
        p.role = 'internal'
        or exists (
          select 1 from public.client_users cu
          where cu.user_id = p.id
            and cu.client_id = p_client_id
            and cu.can_manage
        )
      )
  )
$$;

grant execute on function public.can_manage_client(bigint) to authenticated;

-- ── 3. Scoped overview for managers ────────────────────────────────────────
-- Returns only the clients the caller manages, the users mapped to those
-- clients, and pending invites for those clients. (Internal users get every
-- client so the page works for them too, though they normally use /admin.)
create or replace function public.client_team_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
  v_internal boolean := public.is_internal();
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  with managed as (
    select c.id, c.client_name
    from public.clients c
    where v_internal or public.can_manage_client(c.id)
  )
  select jsonb_build_object(
    'clients', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', m.id, 'client_name', m.client_name) order by m.id), '[]'::jsonb)
      from managed m
    ),
    'members', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'user_id',     cu.user_id,
        'client_id',   cu.client_id,
        'email',       p.email,
        'full_name',   p.full_name,
        'role',        p.role,
        'disabled_at', p.disabled_at,
        'can_manage',  cu.can_manage)), '[]'::jsonb)
      from public.client_users cu
      join managed m         on m.id = cu.client_id
      join public.profiles p on p.id = cu.user_id
    ),
    'pending_invites', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'email', pi.email, 'client_id', pi.client_id, 'created_at', pi.created_at)
        order by pi.created_at desc), '[]'::jsonb)
      from public.pending_invites pi
      join managed m on m.id = pi.client_id
    )
  ) into result;

  return result;
end;
$$;

grant execute on function public.client_team_overview() to authenticated;

-- ── 4. Grant access to a managed client ────────────────────────────────────
create or replace function public.grant_client_access(p_email text, p_client_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email   text := lower(trim(coalesce(p_email, '')));
  v_user_id uuid;
  v_role    text;
begin
  if not public.can_manage_client(p_client_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_email = '' or position('@' in v_email) = 0 then
    raise exception 'invalid_email' using errcode = '22023';
  end if;

  -- Record a pending invite (consumed by the auth trigger on first sign-in if
  -- they don't have an account yet). Managers never confer manage rights.
  insert into public.pending_invites (email, client_id, invited_by)
  values (v_email, p_client_id, auth.uid())
  on conflict (email, client_id) do nothing;

  select id, role into v_user_id, v_role
  from public.profiles where lower(email) = v_email;

  if v_user_id is not null then
    -- Never modify internal users through this path.
    if v_role = 'internal' then
      return;
    end if;

    insert into public.client_users (user_id, client_id, can_manage)
    values (v_user_id, p_client_id, false)
    on conflict (user_id, client_id) do nothing;

    -- Required so the grant actually takes effect for client users who
    -- previously signed up without an invite (locked-out disabled profile).
    update public.profiles
    set disabled_at = null
    where id = v_user_id and role = 'client' and disabled_at is not null;

    -- Invite is now consumed for this client.
    delete from public.pending_invites where email = v_email and client_id = p_client_id;
  end if;
end;
$$;

grant execute on function public.grant_client_access(text, bigint) to authenticated;

-- ── 5. Revoke an existing user's access to a managed client ────────────────
create or replace function public.revoke_client_access(p_user_id uuid, p_client_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  if not public.can_manage_client(p_client_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select role into v_role from public.profiles where id = p_user_id;
  if v_role = 'internal' then
    raise exception 'not_authorized' using errcode = '42501';  -- can't touch internal users
  end if;

  delete from public.client_users
  where user_id = p_user_id and client_id = p_client_id;
end;
$$;

grant execute on function public.revoke_client_access(uuid, bigint) to authenticated;

-- ── 6. Revoke a pending invite for a managed client ────────────────────────
create or replace function public.revoke_client_invite(p_email text, p_client_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_manage_client(p_client_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  delete from public.pending_invites
  where lower(email) = lower(trim(coalesce(p_email, ''))) and client_id = p_client_id;
end;
$$;

grant execute on function public.revoke_client_invite(text, bigint) to authenticated;

-- ── 7. whoami() also returns the clients the caller can manage ─────────────
-- Adding a column changes the RETURNS TABLE shape, so the old function must be
-- dropped first (CREATE OR REPLACE can't change a function's return type).
drop function if exists public.whoami();
create or replace function public.whoami()
returns table (
  id                  uuid,
  email               text,
  full_name           text,
  role                text,
  disabled_at         timestamptz,
  accessible_clients  bigint[],
  manageable_clients  bigint[]
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return;
  end if;

  return query
  select
    p.id, p.email, p.full_name, p.role, p.disabled_at,
    case
      when p.role = 'internal' and p.disabled_at is null
        then (select coalesce(array_agg(c.id order by c.id), array[]::bigint[]) from public.clients c)
      else
        (select coalesce(array_agg(cu.client_id order by cu.client_id), array[]::bigint[])
         from public.client_users cu where cu.user_id = v_uid)
    end as accessible_clients,
    case
      when p.role = 'internal' and p.disabled_at is null
        then (select coalesce(array_agg(c.id order by c.id), array[]::bigint[]) from public.clients c)
      else
        (select coalesce(array_agg(cu.client_id order by cu.client_id), array[]::bigint[])
         from public.client_users cu where cu.user_id = v_uid and cu.can_manage)
    end as manageable_clients
  from public.profiles p
  where p.id = v_uid;
end;
$$;

grant execute on function public.whoami() to authenticated, anon;

-- ── 8. admin_overview() now carries the can_manage flag on mappings ────────
create or replace function public.admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_internal() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'clients', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'client_name', c.client_name) order by c.id), '[]'::jsonb)
      from public.clients c
    ),
    'profiles', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'email', p.email, 'full_name', p.full_name,
        'role', p.role, 'disabled_at', p.disabled_at, 'created_at', p.created_at)
        order by p.created_at desc), '[]'::jsonb)
      from public.profiles p
    ),
    'client_users', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'user_id', cu.user_id, 'client_id', cu.client_id, 'can_manage', cu.can_manage)), '[]'::jsonb)
      from public.client_users cu
    ),
    'pending_invites', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'email', pi.email, 'client_id', pi.client_id, 'created_at', pi.created_at)
        order by pi.created_at desc), '[]'::jsonb)
      from public.pending_invites pi
    ),
    'admin_emails', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'email', ae.email, 'created_at', ae.created_at)
        order by ae.created_at), '[]'::jsonb)
      from public.admin_emails ae
    )
  ) into result;

  return result;
end;
$$;

grant execute on function public.admin_overview() to authenticated;
