-- Store the original inbound email that generated the ingested services.
alter table public.erp_ingestion_emails
  add column source_message text;
