-- Admin page data in a single SECURITY DEFINER call. Mirrors the whoami()
-- pattern: authorization is checked server-side via is_internal(), and the
-- payload is assembled regardless of per-table RLS. This removes the admin
-- page's dependency on five separate authenticated-RLS table reads.

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
        'user_id', cu.user_id, 'client_id', cu.client_id)), '[]'::jsonb)
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
