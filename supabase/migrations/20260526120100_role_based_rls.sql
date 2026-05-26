-- Role-based RLS for clients, automations, runs, team_members, and the
-- security-definer KPI RPCs. Internal users keep full access. Client-role
-- users are restricted to clients they're mapped to in client_users.
--
-- Anon policies are intentionally untouched. The public/unauthenticated
-- viewing surface (anon SELECT on clients/automations/runs/storage logos)
-- pre-existed and is out of scope for this migration.

-- ── clients ───────────────────────────────────────────────────────────────

drop policy if exists "clients_select_authenticated" on public.clients;
create policy "clients_select_authenticated"
on public.clients
for select
to authenticated
using (public.can_access_client(id));

drop policy if exists "clients_update_internal" on public.clients;
create policy "clients_update_internal"
on public.clients
for update
to authenticated
using (public.is_internal())
with check (public.is_internal());

drop policy if exists "clients_insert_internal" on public.clients;
create policy "clients_insert_internal"
on public.clients
for insert
to authenticated
with check (public.is_internal());

drop policy if exists "clients_delete_internal" on public.clients;
create policy "clients_delete_internal"
on public.clients
for delete
to authenticated
using (public.is_internal());

-- ── automations ───────────────────────────────────────────────────────────
--
-- Replaces the prior "authenticated select all" and "authenticated update all"
-- policies that used `true` predicates.

drop policy if exists "automations_select_authenticated"        on public.automations;
drop policy if exists "automations_update_costs_authenticated"  on public.automations;

create policy "automations_select_authenticated"
on public.automations
for select
to authenticated
using (public.can_access_client(client_id));

-- Only internal users can edit automations (cost fields, etc).
create policy "automations_update_internal"
on public.automations
for update
to authenticated
using (public.is_internal())
with check (public.is_internal());

create policy "automations_insert_internal"
on public.automations
for insert
to authenticated
with check (public.is_internal());

create policy "automations_delete_internal"
on public.automations
for delete
to authenticated
using (public.is_internal());

-- ── runs ──────────────────────────────────────────────────────────────────

drop policy if exists "runs_select_authenticated" on public.runs;
create policy "runs_select_authenticated"
on public.runs
for select
to authenticated
using (
  exists (
    select 1 from public.automations a
    where a.id = runs.automation_id
      and public.can_access_client(a.client_id)
  )
);

drop policy if exists "runs_write_internal" on public.runs;
create policy "runs_write_internal"
on public.runs
for all
to authenticated
using (public.is_internal())
with check (public.is_internal());

-- ── team_members + join tables ────────────────────────────────────────────
--
-- Tighten the previously wide-open `to authenticated using (true)` write
-- policies. Reads stay broad (members + their assignments are needed to
-- render dashboards) but scoped to clients the user can access.

drop policy if exists "team_members_write_auth"             on public.team_members;
drop policy if exists "team_members_clients_write_auth"     on public.team_members_clients;
drop policy if exists "team_members_automations_write_auth" on public.team_members_automations;

create policy "team_members_write_internal"
on public.team_members
for all
to authenticated
using (public.is_internal())
with check (public.is_internal());

create policy "team_members_clients_write_internal"
on public.team_members_clients
for all
to authenticated
using (public.is_internal())
with check (public.is_internal());

create policy "team_members_automations_write_internal"
on public.team_members_automations
for all
to authenticated
using (public.is_internal())
with check (public.is_internal());

-- Authenticated read of team_members_clients restricted to accessible clients.
drop policy if exists "team_members_clients_select_auth" on public.team_members_clients;
create policy "team_members_clients_select_auth"
on public.team_members_clients
for select
to authenticated
using (public.can_access_client(client_id));

-- team_members rows themselves: visible if the user can access any client the
-- member is assigned to (or is internal).
drop policy if exists "team_members_select_auth" on public.team_members;
create policy "team_members_select_auth"
on public.team_members
for select
to authenticated
using (
  public.is_internal()
  or exists (
    select 1 from public.team_members_clients tmc
    where tmc.team_member_id = team_members.id
      and public.can_access_client(tmc.client_id)
  )
);

-- Automation assignments: visible if the linked automation belongs to an
-- accessible client.
drop policy if exists "team_members_automations_select_auth" on public.team_members_automations;
create policy "team_members_automations_select_auth"
on public.team_members_automations
for select
to authenticated
using (
  exists (
    select 1 from public.automations a
    where a.id = team_members_automations.automation_id
      and public.can_access_client(a.client_id)
  )
);

-- ── Storage: client logos ─────────────────────────────────────────────────
-- Logo writes are admin-only now (was: any authenticated user).

drop policy if exists "client_logos_write_auth" on storage.objects;
create policy "client_logos_write_internal"
on storage.objects
for all
to authenticated
using (bucket_id = 'client-logos' and public.is_internal())
with check (bucket_id = 'client-logos' and public.is_internal());

-- ── RPC hardening ─────────────────────────────────────────────────────────
--
-- get_client_kpis / get_automation_summaries are SECURITY DEFINER, so they
-- bypass RLS. Add an explicit membership check inside each so a logged-in
-- client can't pass an arbitrary client_id.
--
-- Anon access (the unauthenticated picker/dashboard) is preserved: when
-- auth.uid() is null we keep the old behaviour. Authenticated callers must
-- pass can_access_client.

create or replace function public.get_client_kpis(p_client_id int)
returns table (
  avg_response_s  numeric,
  time_saved_mins numeric,
  costs_saved_eur numeric,
  total_customers bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.can_access_client(p_client_id::bigint) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  return query
  with per_auto as (
    select
      a.status,
      a.manual_execution_time_min,
      a.manual_hourly_cost,
      count(r.id)                                                              as run_count,
      sum(coalesce(r.response_time, 0))                                        as sum_resp_s,
      count(distinct nullif(trim(coalesce(r.customer, '')), ''))               as uniq_customers
    from public.automations a
    left join public.runs r on r.automation_id = a.id
    where a.client_id = p_client_id
    group by a.id, a.status, a.manual_execution_time_min, a.manual_hourly_cost
  )
  select
    case
      when sum(run_count) > 0
      then (sum(sum_resp_s) / sum(run_count))::numeric
      else 0::numeric
    end,
    coalesce(
      sum(
        case
          when lower(coalesce(status, '')) not like '%discovery%'
          then run_count * coalesce(manual_execution_time_min, 5)
          else 0
        end
      ),
      0
    )::numeric,
    sum(
      case
        when lower(coalesce(status, '')) not like '%discovery%'
             and manual_execution_time_min is not null
             and manual_hourly_cost is not null
        then run_count * (manual_hourly_cost * manual_execution_time_min / 60.0)
      end
    )::numeric,
    coalesce(
      sum(
        case
          when lower(trim(coalesce(status, ''))) in ('live', 'testing')
          then uniq_customers
        end
      )::bigint,
      0::bigint
    )
  from per_auto;
end;
$$;

create or replace function public.get_automation_summaries(p_client_id int)
returns table (
  automation_id     int,
  run_count         bigint,
  avg_response_s    numeric,
  last_run_at       timestamptz,
  first_run_at      timestamptz,
  total_savings_eur numeric,
  daily_l10d        jsonb,
  hourly_dist       jsonb,
  weekday_dist      jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.can_access_client(p_client_id::bigint) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  return query
  with
  base as (
    select
      r.automation_id,
      r.response_time,
      r.created_at,
      r.created_at::date              as run_date,
      extract(hour from r.created_at)::int  as run_hour,
      extract(dow  from r.created_at)::int  as run_dow
    from public.runs r
    join public.automations a on a.id = r.automation_id
    where a.client_id = p_client_id
  ),
  overall as (
    select
      automation_id,
      count(*)             as run_count,
      avg(response_time)   as avg_response_s,
      max(created_at)      as last_run_at,
      min(created_at)      as first_run_at
    from base
    group by automation_id
  ),
  day_series as (select generate_series(0, 9) as offset_days),
  day_keys as (
    select offset_days, (current_date - offset_days * interval '1 day')::date as day
    from day_series
  ),
  daily_raw as (
    select automation_id, run_date,
           count(*) as day_run_count,
           avg(response_time) as day_avg_resp_s
    from base
    where run_date >= current_date - 9
    group by automation_id, run_date
  ),
  daily_filled as (
    select a.id as automation_id, a.manual_execution_time_min, dk.day,
           coalesce(d.day_run_count, 0) as day_run_count,
           coalesce(d.day_avg_resp_s, 0) as day_avg_resp_s
    from public.automations a
    cross join day_keys dk
    left join daily_raw d on d.automation_id = a.id and d.run_date = dk.day
    where a.client_id = p_client_id
  ),
  daily_agg as (
    select automation_id,
           jsonb_agg(
             jsonb_build_object(
               'day',        to_char(day, 'YYYY-MM-DD'),
               'run_count',  day_run_count,
               'avg_resp_s', round(day_avg_resp_s::numeric, 1),
               'saved_mins', (day_run_count * coalesce(manual_execution_time_min, 5))::numeric
             )
             order by day asc
           ) as daily_l10d
    from daily_filled
    group by automation_id
  ),
  hourly_raw as (
    select automation_id, run_hour, count(*) as cnt, avg(response_time) as avg_s
    from base
    group by automation_id, run_hour
  ),
  hourly_filled as (
    select a.id as automation_id, h.h,
           coalesce(hr.cnt, 0) as cnt,
           coalesce(hr.avg_s, 0) as avg_s
    from public.automations a
    cross join generate_series(0, 23) as h(h)
    left join hourly_raw hr on hr.automation_id = a.id and hr.run_hour = h.h
    where a.client_id = p_client_id
  ),
  hourly_agg as (
    select automation_id,
           jsonb_agg(
             jsonb_build_object('c', cnt, 's', round(avg_s::numeric, 1))
             order by h
           ) as hourly_dist
    from hourly_filled
    group by automation_id
  ),
  weekday_raw as (
    select automation_id, run_dow, count(*) as cnt
    from base
    group by automation_id, run_dow
  ),
  weekday_filled as (
    select a.id as automation_id, wd.wd,
           coalesce(wr.cnt, 0) as cnt
    from public.automations a
    cross join generate_series(0, 6) as wd(wd)
    left join weekday_raw wr on wr.automation_id = a.id and wr.run_dow = wd.wd
    where a.client_id = p_client_id
  ),
  weekday_agg as (
    select automation_id, jsonb_agg(cnt order by wd) as weekday_dist
    from weekday_filled
    group by automation_id
  )
  select
    a.id::int                                                as automation_id,
    coalesce(o.run_count, 0)::bigint                         as run_count,
    coalesce(o.avg_response_s, 0)::numeric                   as avg_response_s,
    o.last_run_at,
    o.first_run_at,
    case
      when lower(coalesce(a.status, '')) not like '%discovery%'
           and a.manual_execution_time_min is not null
           and a.manual_hourly_cost is not null
      then (coalesce(o.run_count, 0) * (a.manual_hourly_cost * a.manual_execution_time_min / 60.0))::numeric
    end                                                      as total_savings_eur,
    coalesce(da.daily_l10d,   '[]'::jsonb)                   as daily_l10d,
    coalesce(ha.hourly_dist,  '[]'::jsonb)                   as hourly_dist,
    coalesce(wa.weekday_dist, '[]'::jsonb)                   as weekday_dist
  from public.automations a
  left join overall     o  on o.automation_id  = a.id
  left join daily_agg   da on da.automation_id = a.id
  left join hourly_agg  ha on ha.automation_id = a.id
  left join weekday_agg wa on wa.automation_id = a.id
  where a.client_id = p_client_id;
end;
$$;

grant execute on function public.get_client_kpis(int)          to anon, authenticated;
grant execute on function public.get_automation_summaries(int) to anon, authenticated;
