-- Add editable cost columns to public.automations.
-- These are the three inputs in the "Cost model" row of the live-automations
-- section: manual min/task, manual €/hour, and auto €/month.

alter table public.automations
  add column if not exists manual_execution_time_min numeric(10, 2) default null,
  add column if not exists manual_hourly_cost        numeric(10, 2) default null,
  add column if not exists auto_monthly_cost         numeric(10, 2) default null;
