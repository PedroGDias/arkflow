-- Server-side resolver: returns the caller's profile + their accessible
-- client_ids in one call. SECURITY DEFINER so RLS on profiles doesn't filter
-- the row. The frontend uses this instead of selecting from profiles directly,
-- which removes any dependency on the supabase-js auth header attachment.

create or replace function public.whoami()
returns table (
  id                  uuid,
  email               text,
  full_name           text,
  role                text,
  disabled_at         timestamptz,
  accessible_clients  bigint[]
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
    return; -- empty result; frontend treats as "not signed in"
  end if;

  return query
  select
    p.id,
    p.email,
    p.full_name,
    p.role,
    p.disabled_at,
    case
      when p.role = 'internal' and p.disabled_at is null
        then (select coalesce(array_agg(c.id order by c.id), array[]::bigint[]) from public.clients c)
      else
        (select coalesce(array_agg(cu.client_id order by cu.client_id), array[]::bigint[])
         from public.client_users cu
         where cu.user_id = v_uid)
    end as accessible_clients
  from public.profiles p
  where p.id = v_uid;
end;
$$;

grant execute on function public.whoami() to authenticated, anon;
