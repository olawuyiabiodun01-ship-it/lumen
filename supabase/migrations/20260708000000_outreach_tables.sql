create table if not exists outreach (
  id           uuid primary key default gen_random_uuid(),
  user_email   text not null,
  sequence_id  uuid not null,
  step         int  not null default 0,
  prospect_name    text,
  prospect_email   text not null,
  prospect_company text,
  prospect_title   text,
  segment_name     text,
  subject      text not null,
  body         text not null,
  status       text not null default 'draft',
  send_after   timestamptz not null default now(),
  resend_id    text,
  sent_at      timestamptz,
  error        text,
  created_at   timestamptz not null default now()
);

create index if not exists outreach_due_idx    on outreach (status, send_after);
create index if not exists outreach_owner_idx  on outreach (user_email, created_at desc);
create index if not exists outreach_seq_idx     on outreach (sequence_id);

create table if not exists sender_settings (
  user_email        text primary key,
  from_name         text,
  from_email        text,
  reply_to          text,
  signature         text,
  physical_address  text,
  daily_cap         int  not null default 50,
  updated_at        timestamptz not null default now()
);

create table if not exists unsubscribes (
  email       text primary key,
  user_email  text,
  created_at  timestamptz not null default now()
);

alter table outreach        enable row level security;
alter table sender_settings enable row level security;
alter table unsubscribes    enable row level security;
