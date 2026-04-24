-- Set automations 4-18 to Discovery status.
update public.automations
set status = 'Discovery'
where id between 4 and 18;

