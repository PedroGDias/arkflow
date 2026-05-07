-- Aggregated KPIs for a client, computed server-side to avoid fetching raw runs.
--
-- avg_response_s  : run-weighted average response time across all automations
-- time_saved_mins : sum of (run_count × manual_execution_time_min) for non-discovery automations
-- costs_saved_eur : sum of (run_count × manual_hourly_cost × manual_execution_time_min / 60)
--                   for non-discovery automations that have cost fields set; NULL when none do
-- total_customers : sum of DISTINCT customers per automation, only for Live/Testing automations

create or replace function public.get_client_kpis(p_client_id int)
returns table (
  avg_response_s  numeric,
  time_saved_mins numeric,
  costs_saved_eur numeric,
  total_customers bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with per_auto as (
    select
      a.status,
      a.manual_execution_time_min,
      a.manual_hourly_cost,
      count(r.id)                                                              as run_count,
      sum(coalesce(r.response_time, 0))                                        as sum_resp_s,
      -- distinct customers per automation (blank/null excluded)
      count(distinct nullif(trim(coalesce(r.customer, '')), ''))               as uniq_customers
    from public.automations a
    left join public.runs r on r.automation_id = a.id
    where a.client_id = p_client_id
    group by a.id, a.status, a.manual_execution_time_min, a.manual_hourly_cost
  )
  select
    -- weighted avg response time across all runs
    case
      when sum(run_count) > 0
      then (sum(sum_resp_s) / sum(run_count))::numeric
      else 0::numeric
    end,

    -- time saved: non-discovery automations × manual_execution_time_min (default 5 min)
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

    -- costs saved: NULL when no automation has cost data configured, otherwise the sum
    -- (CASE with no ELSE = implicit NULL for unconfigured automations, so SUM of all NULLs → NULL)
    sum(
      case
        when lower(coalesce(status, '')) not like '%discovery%'
             and manual_execution_time_min is not null
             and manual_hourly_cost is not null
        then run_count * (manual_hourly_cost * manual_execution_time_min / 60.0)
      end
    )::numeric,

    -- total customers: sum of per-automation distinct customers, Live/Testing only
    coalesce(
      sum(
        case
          when lower(trim(coalesce(status, ''))) in ('live', 'testing')
          then uniq_customers
        end
      )::bigint,
      0::bigint
    )
  from per_auto
$$;
