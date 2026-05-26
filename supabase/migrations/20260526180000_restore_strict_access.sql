-- Restore the strict access model and re-add the auth trigger (crash-safe).
--
-- Access rules:
--   internal  : email @arkflow.ai  OR  email in admin_emails
--   client    : email has client_users mappings (invited)
--   no access : everyone else  → disabled profile
--
-- The earlier "promote all existing to internal" migration was too broad
-- (it made non-arkflow personal emails internal). This corrects that.

-- ── 1. Re-create the trigger function, wrapped so it can NEVER block the
--       auth.users INSERT (any failure is logged, not raised). ──────────────

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email       text;
  v_domain      text;
  v_full_name   text;
  v_is_admin    boolean;
  v_has_invites boolean;
begin
  begin
    v_email := lower(coalesce(new.email, ''));
    if v_email = '' then
      return new;
    end if;

    v_domain      := split_part(v_email, '@', 2);
    v_full_name   := coalesce(new.raw_user_meta_data->>'full_name',
                              new.raw_user_meta_data->>'name', null);
    v_is_admin    := exists (select 1 from public.admin_emails    where email = v_email);
    v_has_invites := exists (select 1 from public.pending_invites where email = v_email);

    if v_is_admin or v_domain = 'arkflow.ai' then
      insert into public.profiles (id, email, full_name, role, disabled_at)
      values (new.id, v_email, v_full_name, 'internal', null)
      on conflict (id) do update
        set role = 'internal', disabled_at = null, email = excluded.email;

    elsif v_has_invites then
      insert into public.profiles (id, email, full_name, role, disabled_at)
      values (new.id, v_email, v_full_name, 'client', null)
      on conflict (id) do update
        set role = 'client', disabled_at = null, email = excluded.email;

      insert into public.client_users (user_id, client_id)
      select new.id, pi.client_id
      from public.pending_invites pi
      where pi.email = v_email
      on conflict do nothing;

      delete from public.pending_invites where email = v_email;

    else
      -- Unknown email: disabled profile so RLS / whoami rejects them.
      insert into public.profiles (id, email, full_name, role, disabled_at)
      values (new.id, v_email, v_full_name, 'client', now())
      on conflict (id) do nothing;
    end if;

  exception when others then
    raise warning 'handle_new_auth_user failed for %: % (%)', new.id, SQLERRM, SQLSTATE;
  end;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ── 2. Correct existing profiles to the strict model. ──────────────────────

-- Internal: arkflow.ai domain or admin allowlist.
update public.profiles p
set role = 'internal', disabled_at = null
where split_part(lower(p.email), '@', 2) = 'arkflow.ai'
   or exists (select 1 from public.admin_emails a where a.email = lower(p.email));

-- Anyone NOT arkflow.ai, NOT an admin, and with NO client mapping → disabled.
update public.profiles p
set disabled_at = now(), role = 'client'
where split_part(lower(p.email), '@', 2) <> 'arkflow.ai'
  and not exists (select 1 from public.admin_emails a where a.email = lower(p.email))
  and not exists (select 1 from public.client_users cu where cu.user_id = p.id);

-- ── 3. Report resulting state. ─────────────────────────────────────────────

do $$
declare rec record;
begin
  raise notice '── profiles after strict reset ────────────────────';
  for rec in select email, role, disabled_at from public.profiles order by role, email loop
    raise notice 'profile email=% role=% disabled=%', rec.email, rec.role, rec.disabled_at;
  end loop;
end;
$$;
