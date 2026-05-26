// Access control is now enforced by the database via the `profiles` table and
// RLS (see supabase/migrations/20260526120000_profiles_and_client_access.sql).
// This file is retained only for the constant referenced by older comments.

export const ALLOWED_EMAIL_DOMAIN = 'arkflow.ai'
