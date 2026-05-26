-- EMERGENCY: drop the auth.users trigger entirely so it cannot block sign-in.
-- We'll re-introduce it once we've confirmed it isn't the cause.
-- Also dumps current state of auth.users + profiles via RAISE NOTICE so we
-- can see in the migration log exactly what each user looks like.

drop trigger if exists on_auth_user_created on auth.users;

do $$
declare
  rec record;
begin
  raise notice '── auth.users ─────────────────────────────────────';
  for rec in
    select id, email, created_at, last_sign_in_at, email_confirmed_at, is_sso_user
    from auth.users
    order by created_at
  loop
    raise notice 'auth.users id=% email=% created=% last_sign_in=% confirmed=% sso=%',
      rec.id, rec.email, rec.created_at, rec.last_sign_in_at, rec.email_confirmed_at, rec.is_sso_user;
  end loop;

  raise notice '── public.profiles ────────────────────────────────';
  for rec in
    select id, email, role, disabled_at, created_at
    from public.profiles
    order by created_at
  loop
    raise notice 'profiles id=% email=% role=% disabled=% created=%',
      rec.id, rec.email, rec.role, rec.disabled_at, rec.created_at;
  end loop;

  raise notice '── public.admin_emails ────────────────────────────';
  for rec in select email, created_at from public.admin_emails loop
    raise notice 'admin_emails email=% created=%', rec.email, rec.created_at;
  end loop;

  raise notice '── auth.identities (provider info) ─────────────────';
  for rec in
    select user_id, provider, identity_data->>'email' as identity_email, created_at, last_sign_in_at
    from auth.identities
    order by created_at
  loop
    raise notice 'identities user_id=% provider=% identity_email=% created=% last_sign_in=%',
      rec.user_id, rec.provider, rec.identity_email, rec.created_at, rec.last_sign_in_at;
  end loop;
end;
$$;
