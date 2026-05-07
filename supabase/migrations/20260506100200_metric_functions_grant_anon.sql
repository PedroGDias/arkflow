-- Allow anon and authenticated roles to call the metric RPC functions.
-- The functions use SECURITY DEFINER so they can read tables regardless of RLS.

grant execute on function public.get_client_kpis(int)           to anon, authenticated;
grant execute on function public.get_automation_summaries(int)  to anon, authenticated;
