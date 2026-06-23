-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run

create table if not exists public.approved_users (
  email text primary key,
  added_at timestamptz default now()
);

-- Row Level Security stays ON. We never add a public policy, so the only way
-- to read or write this table is with the service role key, which only the
-- Edge Function (and you, via the Dashboard) has. Approved users themselves
-- can never query this table directly.
alter table public.approved_users enable row level security;

-- Seed with whoever you want to approve first. Lowercase, exactly as they'll
-- log in with. Add or remove people anytime later from Table Editor ->
-- approved_users — no redeploy needed.
insert into public.approved_users (email) values
  ('friend1@example.com'),
  ('friend2@example.com')
on conflict (email) do nothing;
