-- Server-side aggregation of julia_thread_stats_prod for a client's automations.
--
-- Replaces a client-side fetch-and-count that was silently truncated by
-- PostgREST's 1000-row response cap, which made completion percentages read
-- e.g. "806/1000" instead of the true totals.
--
-- Returns one row per automation belonging to the client:
--   total       total thread count ever
--   completed   threads with status = 'completed'
--   daily_l10d  10-element JSON array of total thread counts
--               (index 0 = 9 days ago, index 9 = today) — same orientation as
--               get_automation_summaries.daily_l10d so the charts line up.

create or replace function public.get_thread_stats(p_client_id int)
returns table (
  automation_id int,
  total         bigint,
  completed     bigint,
  daily_l10d    jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  with
  -- ── base: all threads for this client's automations ──────────────────────
  base as (
    select
      t.automation_id,
      t.status,
      t.created_at::date as run_date
    from public.julia_thread_stats_prod t
    join public.automations a on a.id = t.automation_id
    where a.client_id = p_client_id
  ),

  -- ── overall per-automation totals ────────────────────────────────────────
  overall as (
    select
      automation_id,
      count(*)                                     as total,
      count(*) filter (where status = 'completed') as completed
    from base
    group by automation_id
  ),

  -- ── daily counts for last 10 days (zero-filled) ──────────────────────────
  day_keys as (
    select
      offset_days,
      (current_date - offset_days * interval '1 day')::date as day
    from generate_series(0, 9) as offset_days
  ),
  daily_raw as (
    select automation_id, run_date, count(*) as cnt
    from base
    where run_date >= current_date - 9
    group by automation_id, run_date
  ),
  daily_filled as (
    select
      a.id               as automation_id,
      dk.day,
      coalesce(d.cnt, 0) as cnt
    from public.automations a
    cross join day_keys dk
    left join daily_raw d on d.automation_id = a.id and d.run_date = dk.day
    where a.client_id = p_client_id
  ),
  daily_agg as (
    select
      automation_id,
      jsonb_agg(cnt order by day asc) as daily_l10d  -- index 0 = 9 days ago
    from daily_filled
    group by automation_id
  )

  -- ── final join ────────────────────────────────────────────────────────────
  select
    a.id::int                             as automation_id,
    coalesce(o.total, 0)::bigint          as total,
    coalesce(o.completed, 0)::bigint      as completed,
    coalesce(da.daily_l10d, '[]'::jsonb)  as daily_l10d
  from public.automations a
  left join overall   o  on o.automation_id  = a.id
  left join daily_agg da on da.automation_id = a.id
  where a.client_id = p_client_id
$$;

grant execute on function public.get_thread_stats(int) to anon, authenticated;
