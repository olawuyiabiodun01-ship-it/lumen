-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run
-- Tracks token usage per reply, so the admin can see usage broken down by person.

create table if not exists public.token_usage (
  id bigint generated always as identity primary key,
  user_email text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  created_at timestamptz default now()
);

create index if not exists token_usage_user_email_idx on public.token_usage (user_email);

-- Same pattern as the other tables: RLS stays on, no public policy added,
-- so only the Edge Function (service role) can read or write this table.
alter table public.token_usage enable row level security;
