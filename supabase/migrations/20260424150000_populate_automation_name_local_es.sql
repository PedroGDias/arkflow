-- Populate Spanish-localized automation names for all rows.
--
-- Policy:
-- - Prefer explicit `automation_name_es` if present.
-- - Otherwise translate known canonical English names.
-- - Otherwise fall back to `automation_name` so no row remains blank.
-- - Do not overwrite an existing non-empty `automation_name_local`.

update public.automations a
set automation_name_local =
  coalesce(
    nullif(a.automation_name_es, ''),
    case lower(trim(coalesce(a.automation_name_en, a.automation_name, '')))
      when 'change in reservations' then 'Cambios en reservas'
      when 'reservation cancellations' then 'Cancelaciones de reservas'
      when 'fiscal data gathering' then 'Recopilación de datos fiscales'
      when 'payments follow up' then 'Seguimiento de pagos'
      when 'invoice request' then 'Solicitud de factura'
      when 'quote request' then 'Solicitud de presupuesto'
      else null
    end,
    nullif(trim(a.automation_name_local), ''),
    nullif(trim(a.automation_name), '')
  )
where coalesce(nullif(a.automation_name_local, ''), '') = '';

