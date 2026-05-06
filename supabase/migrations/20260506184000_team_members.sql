-- Team members as real DB rows, with assignments to clients and automations.

create table if not exists public.team_members (
  id bigserial primary key,
  slug text unique not null,
  initials text not null,
  name text not null,
  role_en text not null,
  role_es text not null,
  avatar_bg text null,
  avatar_color text null,
  sort_order int not null default 1000,
  created_at timestamptz not null default now()
);

create table if not exists public.team_members_clients (
  team_member_id bigint not null references public.team_members(id) on delete cascade,
  client_id bigint not null references public.clients(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (team_member_id, client_id)
);

create table if not exists public.team_members_automations (
  team_member_id bigint not null references public.team_members(id) on delete cascade,
  automation_id bigint not null references public.automations(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (team_member_id, automation_id)
);

alter table public.team_members enable row level security;
alter table public.team_members_clients enable row level security;
alter table public.team_members_automations enable row level security;

-- Read access (anon) to render dashboards without auth coupling.
drop policy if exists "team_members_select_anon" on public.team_members;
create policy "team_members_select_anon"
on public.team_members
for select
to anon
using (true);

drop policy if exists "team_members_clients_select_anon" on public.team_members_clients;
create policy "team_members_clients_select_anon"
on public.team_members_clients
for select
to anon
using (true);

drop policy if exists "team_members_automations_select_anon" on public.team_members_automations;
create policy "team_members_automations_select_anon"
on public.team_members_automations
for select
to anon
using (true);

-- Writes require authenticated session (Admin usage).
drop policy if exists "team_members_write_auth" on public.team_members;
create policy "team_members_write_auth"
on public.team_members
for all
to authenticated
using (true)
with check (true);

drop policy if exists "team_members_clients_write_auth" on public.team_members_clients;
create policy "team_members_clients_write_auth"
on public.team_members_clients
for all
to authenticated
using (true)
with check (true);

drop policy if exists "team_members_automations_write_auth" on public.team_members_automations;
create policy "team_members_automations_write_auth"
on public.team_members_automations
for all
to authenticated
using (true)
with check (true);

