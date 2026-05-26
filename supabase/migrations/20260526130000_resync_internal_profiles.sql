-- Corrective resync: ensure every auth.users row with an @arkflow.ai email
-- has a matching public.profiles row with role='internal' and disabled_at=null.
--
-- The initial backfill in 20260526120000 used `on conflict (id) do nothing`
-- which is safe but doesn't fix existing-but-misconfigured rows. This one
-- upserts and forcibly corrects role + disabled_at for arkflow.ai accounts.

insert into public.profiles (id, email, full_name, role, disabled_at)
select
  u.id,
  lower(u.email),
  coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'),
  'internal',
  null
from auth.users u
where u.email is not null
  and split_part(lower(u.email), '@', 2) = 'arkflow.ai'
on conflict (id) do update
set role        = 'internal',
    disabled_at = null,
    email       = excluded.email;
