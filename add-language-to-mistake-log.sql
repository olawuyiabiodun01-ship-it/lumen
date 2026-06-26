-- Run this once in Supabase SQL Editor.
-- Adds a language column so mistake patterns are tracked per practice
-- language, now that Lumen supports both German and Yoruba.

alter table public.mistake_log
  add column if not exists language text not null default 'de';

create index if not exists mistake_log_language_idx on public.mistake_log (language);
