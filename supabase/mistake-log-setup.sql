-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run
-- Adds the table that lets Lumen notice recurring German mistakes over time.

create table if not exists public.mistake_log (
  id bigint generated always as identity primary key,
  user_email text not null,
  category text not null,       -- e.g. "der/die/das gender", "verb conjugation"
  example text,                  -- the original sentence that had the mistake
  created_at timestamptz default now()
);

create index if not exists mistake_log_user_email_idx on public.mistake_log (user_email);

-- Same pattern as approved_users: RLS stays on, no public policy added,
-- so only the Edge Function (service role) can read or write this table.
alter table public.mistake_log enable row level security;
