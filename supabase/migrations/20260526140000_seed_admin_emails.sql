-- Explicit admin allowlist. These emails are guaranteed to land as
-- role=internal / enabled, regardless of the @arkflow.ai domain rule or any
-- prior backfill state.
--
-- 1. A small admin_emails table holds the canonical list (so it can be
--    queried, audited, and extended without code changes).
-- 2. The new-auth-user trigger consults it first (before the domain check).
-- 3. Existing auth.users rows matching the list are force-corrected now.

create table if not exists public.admin_emails (
  email      text primary key check (email = lower(email)),
  created_at timestamptz not null default now()
);

insert into public.admin_emails (email) values
  ('pedro@arkflow.ai'),
  ('info@arkflow.ai')
on conflict (email) do nothing;

alter table public.admin_emails enable row level security;

drop policy if exists "admin_emails_internal_all" on public.admin_emails;
create policy "admin_emails_internal_all"
on public.admin_emails
for all
to authenticated
using (public.is_internal())
with check (public.is_internal());

-- Replace the new-auth-user trigger to consult admin_emails first.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email     text := lower(coalesce(new.email, ''));
  v_domain    text;
  v_full_name text := coalesce(new.raw_user_meta_data->>'full_name',
                               new.raw_user_meta_data->>'name',
                               null);
  v_is_admin    boolean;
  v_has_invites boolean;
begin
  if v_email = '' then
    return new;
  end if;

  v_domain      := split_part(v_email, '@', 2);
  v_is_admin    := exists (select 1 from public.admin_emails where email = v_email);
  v_has_invites := exists (select 1 from public.pending_invites where email = v_email);

  if v_is_admin or v_domain = 'arkflow.ai' then
    insert into public.profiles (id, email, full_name, role, disabled_at)
    values (new.id, v_email, v_full_name, 'internal', null)
    on conflict (id) do update
      set role = 'internal', disabled_at = null, email = excluded.email;

  elsif v_has_invites then
    insert into public.profiles (id, email, full_name, role, disabled_at)
    values (new.id, v_email, v_full_name, 'client', null)
    on conflict (id) do nothing;

    insert into public.client_users (user_id, client_id)
    select new.id, pi.client_id
    from public.pending_invites pi
    where pi.email = v_email
    on conflict do nothing;

    delete from public.pending_invites where email = v_email;

  else
    insert into public.profiles (id, email, full_name, role, disabled_at)
    values (new.id, v_email, v_full_name, 'client', now())
    on conflict (id) do nothing;
  end if;

  return new;
end;
$$;

-- Force-correct any existing auth.users row whose email is in the allowlist.
insert into public.profiles (id, email, full_name, role, disabled_at)
select
  u.id,
  lower(u.email),
  coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'),
  'internal',
  null
from auth.users u
join public.admin_emails ae on ae.email = lower(u.email)
on conflict (id) do update
set role        = 'internal',
    disabled_at = null,
    email       = excluded.email;
