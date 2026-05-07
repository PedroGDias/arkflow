-- Per-automation summaries for a client, computed server-side.
--
-- Returns one row per automation belonging to the client, including:
--   run_count        total runs ever
--   avg_response_s   average response time (seconds)
--   last_run_at      most recent run timestamp
--   first_run_at     oldest run timestamp (used for months-active ROI calc)
--   total_savings_eur actual savings = run_count × (hourly_cost × exec_mins / 60);
--                    NULL when cost fields are not configured
--   daily_l10d       10-element JSON array (index 0 = 9 days ago, index 9 = today)
--                    each element: {day, run_count, avg_resp_s, saved_mins}
--   hourly_dist      24-element JSON array (index = hour 0–23)
--                    each element: {c: run_count, s: avg_response_s}
--   weekday_dist     7-element JSON array (index = weekday, 0=Sunday … 6=Saturday)
--                    each element: run_count for that weekday

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
language sql
stable
security definer
set search_path = public
as $$
  with
  -- ── base: all runs for this client ──────────────────────────────────────
  base as (
    select
      r.automation_id,
      r.response_time,
      r.created_at,
      r.created_at::date              as run_date,
      extract(hour from r.created_at)::int  as run_hour,
      extract(dow  from r.created_at)::int  as run_dow   -- 0=Sun
    from public.runs r
    join public.automations a on a.id = r.automation_id
    where a.client_id = p_client_id
  ),

  -- ── overall per-automation stats ─────────────────────────────────────────
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

  -- ── daily stats for last 10 days (zero-filled) ───────────────────────────
  day_series as (
    select generate_series(0, 9) as offset_days
  ),
  day_keys as (
    select
      offset_days,
      (current_date - offset_days * interval '1 day')::date as day
    from day_series
  ),
  daily_raw as (
    select
      automation_id,
      run_date,
      count(*)           as day_run_count,
      avg(response_time) as day_avg_resp_s
    from base
    where run_date >= current_date - 9
    group by automation_id, run_date
  ),
  daily_filled as (
    select
      a.id                                                   as automation_id,
      a.manual_execution_time_min,
      dk.day,
      coalesce(d.day_run_count, 0)                           as day_run_count,
      coalesce(d.day_avg_resp_s, 0)                          as day_avg_resp_s
    from public.automations a
    cross join day_keys dk
    left join daily_raw d on d.automation_id = a.id and d.run_date = dk.day
    where a.client_id = p_client_id
  ),
  daily_agg as (
    select
      automation_id,
      jsonb_agg(
        jsonb_build_object(
          'day',        to_char(day, 'YYYY-MM-DD'),
          'run_count',  day_run_count,
          'avg_resp_s', round(day_avg_resp_s::numeric, 1),
          'saved_mins', (day_run_count * coalesce(manual_execution_time_min, 5))::numeric
        )
        order by day asc   -- index 0 = oldest (9 days ago), index 9 = today
      ) as daily_l10d
    from daily_filled
    group by automation_id
  ),

  -- ── hourly distribution (dense 24-element array) ─────────────────────────
  hourly_raw as (
    select
      automation_id,
      run_hour,
      count(*)           as cnt,
      avg(response_time) as avg_s
    from base
    group by automation_id, run_hour
  ),
  hourly_filled as (
    select
      a.id   as automation_id,
      h.h,
      coalesce(hr.cnt,   0) as cnt,
      coalesce(hr.avg_s, 0) as avg_s
    from public.automations a
    cross join generate_series(0, 23) as h(h)
    left join hourly_raw hr on hr.automation_id = a.id and hr.run_hour = h.h
    where a.client_id = p_client_id
  ),
  hourly_agg as (
    select
      automation_id,
      jsonb_agg(
        jsonb_build_object('c', cnt, 's', round(avg_s::numeric, 1))
        order by h
      ) as hourly_dist
    from hourly_filled
    group by automation_id
  ),

  -- ── weekday distribution (dense 7-element array, 0=Sun) ──────────────────
  weekday_raw as (
    select
      automation_id,
      run_dow,
      count(*) as cnt
    from base
    group by automation_id, run_dow
  ),
  weekday_filled as (
    select
      a.id   as automation_id,
      wd.wd,
      coalesce(wr.cnt, 0) as cnt
    from public.automations a
    cross join generate_series(0, 6) as wd(wd)
    left join weekday_raw wr on wr.automation_id = a.id and wr.run_dow = wd.wd
    where a.client_id = p_client_id
  ),
  weekday_agg as (
    select
      automation_id,
      jsonb_agg(cnt order by wd) as weekday_dist
    from weekday_filled
    group by automation_id
  )

  -- ── final join ────────────────────────────────────────────────────────────
  select
    a.id::int                                                as automation_id,
    coalesce(o.run_count, 0)::bigint                         as run_count,
    coalesce(o.avg_response_s, 0)::numeric                   as avg_response_s,
    o.last_run_at,
    o.first_run_at,
    -- NULL when cost fields not configured (CASE with no ELSE → implicit NULL)
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
  where a.client_id = p_client_id
$$;
