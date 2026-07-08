-- Stage 4 — outreach / auto-send tables.
-- Run this once in Supabase → SQL Editor (or via `supabase db push`).
--
-- Design goals baked into the schema:
--   • nothing sends until a row is explicitly 'approved'
--   • every send is scheduled (send_after), so the cron just drains what's due
--   • unsubscribes are honoured globally, per recipient email
--   • one "sequence_id" groups a prospect's initial email + its follow-ups,
--     so a reply/unsubscribe can stop the whole sequence at once

-- The queue: one row per (prospect, step in the sequence).
create table if not exists outreach (
  id           uuid primary key default gen_random_uuid(),
  user_email   text not null,               -- who owns / is sending this
  sequence_id  uuid not null,               -- groups initial + follow-ups for one prospect
  step         int  not null default 0,     -- 0 = initial, 1..n = follow-ups
  prospect_name    text,
  prospect_email   text not null,
  prospect_company text,
  prospect_title   text,
  segment_name     text,
  subject      text not null,
  body         text not null,
  status       text not null default 'draft',
    -- draft → approved → sent | failed
    -- and out-of-band: paused | replied | unsubscribed | canceled
  send_after   timestamptz not null default now(),
  resend_id    text,                         -- Resend message id, once sent
  sent_at      timestamptz,
  error        text,
  created_at   timestamptz not null default now()
);

create index if not exists outreach_due_idx    on outreach (status, send_after);
create index if not exists outreach_owner_idx  on outreach (user_email, created_at desc);
create index if not exists outreach_seq_idx     on outreach (sequence_id);

-- Per-user sending identity + compliance details. A user cannot send until
-- from_email is set to an address on a Resend-verified domain.
create table if not exists sender_settings (
  user_email        text primary key,
  from_name         text,
  from_email        text,          -- MUST be on a Resend-verified domain
  reply_to          text,
  signature         text,          -- appended above the footer
  physical_address  text,          -- required by CAN-SPAM; appears in footer
  daily_cap         int  not null default 50,
  updated_at        timestamptz not null default now()
);

-- Global suppression list. Once an address is here, the cron never sends to it.
create table if not exists unsubscribes (
  email       text primary key,
  user_email  text,
  created_at  timestamptz not null default now()
);

-- RLS: these tables are only ever touched by Edge Functions using the service
-- role (which bypasses RLS), so we enable RLS with no policies to block any
-- direct access via the anon/auth keys from the browser.
alter table outreach        enable row level security;
alter table sender_settings enable row level security;
alter table unsubscribes    enable row level security;


-- ============================================================================
-- SCHEDULE THE SENDER (run this part AFTER deploying the outreach-cron function
-- and setting the CRON_SECRET + RESEND_API_KEY secrets).
--
-- Fill in the two placeholders below:
--   <PROJECT_REF>  → your project ref (apvslzcldlqzskawpzzk)
--   <CRON_SECRET>  → the same value you passed to `supabase secrets set CRON_SECRET=...`
-- ============================================================================

-- These extensions ship with Supabase; enable them if not already on.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Poke the sender every 5 minutes. It only sends what's approved and due, so a
-- frequent schedule just keeps latency low — it does not send faster.
-- Run once; re-running with the same job name will error (unschedule first).
select cron.schedule(
  'lumen-outreach-send',
  '*/5 * * * *',
  $$
    select net.http_post(
      url     := 'https://<PROJECT_REF>.functions.supabase.co/outreach-cron',
      headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
      body    := '{}'::jsonb
    );
  $$
);

-- To change or remove it later:
--   select cron.unschedule('lumen-outreach-send');
