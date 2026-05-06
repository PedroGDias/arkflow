-- Seed team members and assignments (mirrors previous frontend hardcoding).
-- Client 1:
-- - Carla: automations 1-5
-- - Lucas: automations 6-8
-- - Sofía: no automations initially
-- Client 2:
-- - Sofía assigned, with automation 19

insert into public.team_members (slug, initials, name, role_en, role_es, avatar_bg, avatar_color, sort_order)
values
  ('carla', 'CA', 'Carla', 'Bookings Specialist', 'Especialista de reservas', 'var(--brand-bg)', 'var(--brand)', 10),
  ('lucas', 'LU', 'Lucas', 'Finance & Admin Specialist', 'Especialista de finanzas y administración', '#f5eae4', '#b35a2a', 20),
  ('sofia', 'SO', 'Sofía', 'Customer Support Specialist', 'Especialista de atención al cliente', '#e8eef8', '#2a5ab3', 30)
on conflict (slug) do update
set
  initials = excluded.initials,
  name = excluded.name,
  role_en = excluded.role_en,
  role_es = excluded.role_es,
  avatar_bg = excluded.avatar_bg,
  avatar_color = excluded.avatar_color,
  sort_order = excluded.sort_order;

-- Assign members to clients
insert into public.team_members_clients (team_member_id, client_id)
select m.id, c.client_id
from public.team_members m
cross join (values (1), (2)) as c(client_id)
where (c.client_id = 1 and m.slug in ('carla','lucas','sofia'))
   or (c.client_id = 2 and m.slug in ('sofia'))
on conflict do nothing;

-- Assign automations to members (client 1 mapping)
insert into public.team_members_automations (team_member_id, automation_id)
select m.id, a.automation_id
from public.team_members m
cross join (
  values
    ('carla', 1), ('carla', 2), ('carla', 3), ('carla', 4), ('carla', 5),
    ('lucas', 6), ('lucas', 7), ('lucas', 8),
    ('sofia', 19)
) as a(member_slug, automation_id)
where m.slug = a.member_slug
on conflict do nothing;

