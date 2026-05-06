-- Fix: client 2 should have Carla (not Sofía) assigned.
-- Also move automation 19 assignment from Sofía -> Carla.

do $$
declare
  carla_id bigint;
  sofia_id bigint;
begin
  select id into carla_id from public.team_members where slug = 'carla';
  select id into sofia_id from public.team_members where slug = 'sofia';

  if carla_id is null then
    raise exception using message = 'Missing team member slug=carla (expected seed to exist).';
  end if;
  if sofia_id is null then
    raise exception using message = 'Missing team member slug=sofia (expected seed to exist).';
  end if;

  -- Ensure Carla is assigned to client 2
  insert into public.team_members_clients (team_member_id, client_id)
  values (carla_id, 2)
  on conflict do nothing;

  -- Remove Sofía from client 2 (if present)
  delete from public.team_members_clients
  where team_member_id = sofia_id
    and client_id = 2;

  -- Move automation 19 ownership from Sofía to Carla
  delete from public.team_members_automations
  where team_member_id = sofia_id
    and automation_id = 19;

  insert into public.team_members_automations (team_member_id, automation_id)
  values (carla_id, 19)
  on conflict do nothing;
end
$$;

