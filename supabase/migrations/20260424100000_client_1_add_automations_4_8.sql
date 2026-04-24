-- Add new Client 1 automations (IDs 4-8) safely.
--
-- Constraints:
-- - Do NOT modify or delete any existing automation rows.
-- - If any of these IDs already exist for a different client, abort (IDs are globally unique).
-- - If an ID already exists for client 1, leave it unchanged.

do $$
declare
  bad_count int;
begin
  select count(*)
    into bad_count
  from public.automations a
  where a.id in (4, 5, 6, 7, 8)
    and a.client_id <> 1;

  if bad_count > 0 then
    raise exception
      using
        message = 'Refusing to insert automations 4-8: one or more IDs already belong to a different client.';
  end if;
end
$$;

insert into public.automations (id, client_id, automation_name, automation_name_local, status)
select v.id, 1, v.en, v.es, v.status
from (
  values
    (4, 'Change in reservations',        'Cambios en reservas',                 'Live'),
    (5, 'Reservation cancellations',     'Cancelaciones de reservas',           'Live'),
    (6, 'Fiscal data gathering',         'Recopilación de datos fiscales',      'Live'),
    (7, 'Payments follow up',            'Seguimiento de pagos',                'Live'),
    (8, 'Invoice request',               'Solicitud de factura',                'Live')
) as v(id, en, es, status)
where not exists (
  select 1
  from public.automations a
  where a.id = v.id
    and a.client_id = 1
);

