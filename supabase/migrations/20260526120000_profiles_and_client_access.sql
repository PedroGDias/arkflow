-- Role-based client access.
--
-- Adds profiles (auth.users metadata), client_users (which clients each user can see),
-- pending_invites (admin-issued invites that auto-resolve on first sign-in), and
-- helper functions used by RLS policies in the follow-up migration.

-- ── Tables ────────────────────────────────────────────────────────────────

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  role        text not null check (role in ('internal','client')),
  disabled_at timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists profiles_email_idx on public.profiles (lower(email));
create index if not exists profiles_role_idx  on public.profiles (role) where disabled_at is null;

create table if not exists public.client_users (
  user_id    uuid   not null references public.profiles(id) on delete cascade,
  client_id  bigint not null references public.clients(id)  on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, client_id)
);

create index if not exists client_users_client_idx on public.client_users (client_id);

-- Admins use this to invite an external client by email before they sign in.
-- When the user later signs up via magic link, a trigger consumes the row and
-- materialises the profile + client_users mappings.
create table if not exists public.pending_invites (
  email       text not null check (email = lower(email)),
  client_id   bigint not null references public.clients(id) on delete cascade,
  invited_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (email, client_id)
);

-- ── Helpers (SECURITY DEFINER so policies can call them without recursion) ──

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from public.profiles
  where id = auth.uid()
    and disabled_at is null
$$;

create or replace function public.is_internal()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role = 'internal'
      and disabled_at is null
  )
$$;

create or replace function public.can_access_client(p_client_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.disabled_at is null
      and (
        p.role = 'internal'
        or exists (
          select 1 from public.client_users cu
          where cu.user_id = p.id and cu.client_id = p_client_id
        )
      )
  )
$$;

grant execute on function public.current_user_role()        to authenticated;
grant execute on function public.is_internal()              to authenticated;
grant execute on function public.can_access_client(bigint)  to authenticated, anon;

-- ── Auto-provision on sign-up ─────────────────────────────────────────────
--
-- When a new auth.users row is created (Google OAuth, magic link, etc.), we
-- create a matching profile:
--   • @arkflow.ai email          → role=internal, enabled
--   • email has pending_invites  → role=client,   enabled, mapped to invited clients
--   • anything else              → role=client,   DISABLED (locked out)
--
-- This means random sign-ups can't see anything until an admin invites them.

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
  v_has_invites boolean;
begin
  if v_email = '' then
    return new;
  end if;

  v_domain := split_part(v_email, '@', 2);
  v_has_invites := exists (select 1 from public.pending_invites where email = v_email);

  if v_domain = 'arkflow.ai' then
    insert into public.profiles (id, email, full_name, role, disabled_at)
    values (new.id, v_email, v_full_name, 'internal', null)
    on conflict (id) do nothing;

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
    -- Unknown email: create a disabled profile so RLS rejects them everywhere.
    insert into public.profiles (id, email, full_name, role, disabled_at)
    values (new.id, v_email, v_full_name, 'client', now())
    on conflict (id) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ── Backfill profiles for existing auth.users ─────────────────────────────
--
-- Anyone who has previously signed in becomes a profile row. The current
-- frontend allowlist only permits @arkflow.ai, so existing users get role=internal.
-- Non-@arkflow.ai rows (if any exist from manual creation) get disabled until
-- an admin explicitly enables them.

insert into public.profiles (id, email, full_name, role, disabled_at)
select
  u.id,
  lower(u.email),
  coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'),
  case when split_part(lower(u.email), '@', 2) = 'arkflow.ai' then 'internal' else 'client' end,
  case when split_part(lower(u.email), '@', 2) = 'arkflow.ai' then null else now() end
from auth.users u
where u.email is not null
on conflict (id) do nothing;

-- ── RLS on the new tables ─────────────────────────────────────────────────

alter table public.profiles        enable row level security;
alter table public.client_users    enable row level security;
alter table public.pending_invites enable row level security;

-- profiles: a user can read their own row; internal can read all.
drop policy if exists "profiles_self_select"     on public.profiles;
create policy "profiles_self_select"
on public.profiles
for select
to authenticated
using (id = auth.uid() or public.is_internal());

-- Only internal users can modify profiles (e.g. flip disabled_at, change role).
drop policy if exists "profiles_internal_write" on public.profiles;
create policy "profiles_internal_write"
on public.profiles
for all
to authenticated
using (public.is_internal())
with check (public.is_internal());

-- client_users: a user can see their own mappings; internal can see all.
drop policy if exists "client_users_self_select" on public.client_users;
create policy "client_users_self_select"
on public.client_users
for select
to authenticated
using (user_id = auth.uid() or public.is_internal());

drop policy if exists "client_users_internal_write" on public.client_users;
create policy "client_users_internal_write"
on public.client_users
for all
to authenticated
using (public.is_internal())
with check (public.is_internal());

-- pending_invites: internal-only (no client ever needs to read these).
drop policy if exists "pending_invites_internal_all" on public.pending_invites;
create policy "pending_invites_internal_all"
on public.pending_invites
for all
to authenticated
using (public.is_internal())
with check (public.is_internal());
