-- ERP Quote Ingestion (automation 21, Autocares Julia / client 1)
-- One ingested email (the requester) -> many services (trip legs).

-- Parent: one row per ingested email.
create table public.erp_ingestion_emails (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  automation_id bigint not null references public.automations (id) on delete cascade,
  email_id      text unique,
  email_subject text,
  contact_name  text,
  contact_email text,
  contact_phone text
);

create index erp_ingestion_emails_automation_id_idx on public.erp_ingestion_emails (automation_id);
create index erp_ingestion_emails_created_at_idx on public.erp_ingestion_emails (created_at desc);

-- Child: one row per service (trip leg) spawned from an email.
create table public.erp_ingestion_services (
  id                 bigint generated always as identity primary key,
  created_at         timestamptz not null default now(),
  email_row_id       bigint not null references public.erp_ingestion_emails (id) on delete cascade,
  origin             text,
  destination        text,
  passengers         text,
  departure_datetime timestamptz,
  arrival_datetime   timestamptz,
  itinerary          text
);

create index erp_ingestion_services_email_row_id_idx on public.erp_ingestion_services (email_row_id);

-- RLS: mirror the `runs` table conventions.
alter table public.erp_ingestion_emails enable row level security;
alter table public.erp_ingestion_services enable row level security;

-- emails: read scoped to client access (via the parent automation), writes internal-only.
create policy erp_ingestion_emails_select_authenticated
  on public.erp_ingestion_emails for select to authenticated
  using (exists (
    select 1 from public.automations a
    where a.id = erp_ingestion_emails.automation_id
      and can_access_client(a.client_id)
  ));

create policy erp_ingestion_emails_select_client_1_anon
  on public.erp_ingestion_emails for select to anon
  using (exists (
    select 1 from public.automations a
    where a.id = erp_ingestion_emails.automation_id
      and a.client_id = 1
  ));

create policy erp_ingestion_emails_write_internal
  on public.erp_ingestion_emails for all to authenticated
  using (is_internal()) with check (is_internal());

-- services: read/write follow visibility of the parent email row.
create policy erp_ingestion_services_select_authenticated
  on public.erp_ingestion_services for select to authenticated
  using (exists (
    select 1
    from public.erp_ingestion_emails e
    join public.automations a on a.id = e.automation_id
    where e.id = erp_ingestion_services.email_row_id
      and can_access_client(a.client_id)
  ));

create policy erp_ingestion_services_select_client_1_anon
  on public.erp_ingestion_services for select to anon
  using (exists (
    select 1
    from public.erp_ingestion_emails e
    join public.automations a on a.id = e.automation_id
    where e.id = erp_ingestion_services.email_row_id
      and a.client_id = 1
  ));

create policy erp_ingestion_services_write_internal
  on public.erp_ingestion_services for all to authenticated
  using (is_internal()) with check (is_internal());
