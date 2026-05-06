-- Store client logos in Supabase Storage and reference them from public.clients.
-- Logos are read publicly (anon) so the picker page can render without auth-coupling.

alter table public.clients
  add column if not exists logo_path text;

-- Storage bucket for client logos (public read).
insert into storage.buckets (id, name, public)
values ('client-logos', 'client-logos', true)
on conflict (id) do update set public = excluded.public;

-- Policies for reading logos (picker page uses anon key in some environments).
drop policy if exists "client_logos_read_anon" on storage.objects;
create policy "client_logos_read_anon"
on storage.objects
for select
to anon
using (bucket_id = 'client-logos');

-- Policies for managing logos (requires a real auth session).
drop policy if exists "client_logos_write_auth" on storage.objects;
create policy "client_logos_write_auth"
on storage.objects
for all
to authenticated
using (bucket_id = 'client-logos')
with check (bucket_id = 'client-logos');

