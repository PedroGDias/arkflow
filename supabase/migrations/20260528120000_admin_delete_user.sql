-- Hard-delete a user (internal-admin only).
--
-- A delete has to remove the auth.users row, not just the profile: profiles.id
-- references auth.users(id) ON DELETE CASCADE, so deleting auth.users cascades
-- to profiles -> client_users. Deleting only the profile would leave the auth
-- user, and the on-signup trigger would re-materialise a (disabled) profile on
-- their next sign-in.
--
-- We also clear the user's email from pending_invites and admin_emails so a
-- deleted user isn't silently re-provisioned on a future sign-in. The
-- @arkflow.ai domain rule in handle_new_auth_user() still applies — deleting an
-- @arkflow.ai teammate removes their current record but they'd be re-created as
-- internal if they sign in again, which is the intended domain behaviour.

create or replace function public.admin_delete_user(target uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if not public.is_internal() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if target = auth.uid() then
    raise exception 'You can''t delete your own account.' using errcode = 'P0001';
  end if;

  select lower(email) into v_email from public.profiles where id = target;

  -- Never delete the last active internal admin.
  if exists (
    select 1 from public.profiles
    where id = target and role = 'internal' and disabled_at is null
  ) and (
    select count(*) from public.profiles
    where role = 'internal' and disabled_at is null
  ) <= 1 then
    raise exception 'Can''t delete the last active admin.' using errcode = 'P0001';
  end if;

  -- Cascades: auth.users -> profiles -> client_users.
  delete from auth.users where id = target;

  if v_email is not null then
    delete from public.pending_invites where email = v_email;
    delete from public.admin_emails    where email = v_email;
  end if;
end;
$$;

grant execute on function public.admin_delete_user(uuid) to authenticated;
