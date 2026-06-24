# Lumen — Your German Practice Buddy

A warm, voice-based companion that listens to you practice German, corrects mistakes gently in the moment, and remembers recurring patterns over time. Built as an installable web app, gated to whichever people you explicitly approve.

## What it does

- **Hands-free conversation** — tap once to wake her up, then just talk. She listens, replies, and starts listening again automatically.
- **Bilingual correction, automatically mixed** — if you say something wrong in German, she corrects it in German and explains the mistake in one short English line, in the same breath, without you switching any setting.
- **Notices patterns over time** — if you keep mixing up the same thing (e.g. der/die/das gender), she's nudged to point it out warmly after it's happened a couple of times.
- **Short-term memory** — remembers roughly your last 24 messages, even after closing and reopening the app.
- **Live waveform** — a row of bars reacts to your actual mic input, so you can see she's hearing you.
- **Installable** — add it to your phone's home screen or desktop like a real app (PWA), with its own icon.
- **Access-controlled** — only emails you've explicitly approved can log in and use it, and you're the one paying for and watching your own API usage.

## Architecture

```
Browser (index.html — plain HTML/JS, no build step, no framework)
   │  magic-link login
   ▼
Supabase Auth — confirms who you are
   │  authenticated request
   ▼
Supabase Edge Function (lumen-chat)
   │  checks the approved_users table, then calls Anthropic
   │  with the real API key — the browser never sees it
   ▼
Anthropic API — generates the reply, streamed back sentence by sentence
```

Two Postgres tables (in the same Supabase project):
- **`approved_users`** — the allowlist. Add or remove rows anytime in the Table Editor; no redeploy needed.
- **`mistake_log`** — recurring German mistakes per person, quietly logged in the background after each reply, used to spot patterns over time.

## File layout

Everything lives in one folder, which is both the GitHub repo and the Supabase CLI project:

```
LUMEN/
├── index.html                  → the app itself (served live by GitHub Pages)
├── lumen-bg.jpg                 → background artwork
├── manifest.json                → PWA manifest (install metadata)
├── sw.js                         → service worker (required for installability)
├── icon-192.png / icon-512.png  → app icons
├── README.md                    → this file
├── DEPLOY.md                    → full step-by-step setup instructions
└── supabase/                     → used by the Supabase CLI, not served publicly
    ├── setup.sql                    → creates approved_users
    ├── mistake-log-setup.sql        → creates mistake_log
    └── functions/lumen-chat/index.ts → the Edge Function, deployed via CLI
```

## Setup

Full instructions are in `DEPLOY.md`. Short version:

1. Run `setup.sql` and `mistake-log-setup.sql` in Supabase's SQL Editor
2. Deploy the Edge Function: `supabase functions deploy lumen-chat`
3. Set your Anthropic key as a secret: `supabase secrets set ANTHROPIC_API_KEY=...`
4. Configure custom SMTP (e.g. Resend) under Supabase → Authentication → SMTP Settings, so login emails actually send — and make sure the sender address is on a **verified domain**, or only your own email will ever receive a login link
5. Fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY` near the top of `index.html`
6. Push everything to GitHub and enable GitHub Pages on the repo

## Managing who can use it

Supabase Dashboard → Table Editor → `approved_users` → add or remove a row. Takes effect immediately, no redeploy.

## Costs

- **Supabase**: free tier comfortably covers a handful of users
- **Resend**: free tier (3,000 emails/month) is far more than login emails will ever need
- **Anthropic**: billed per token on your own account — casual use by a few people typically runs from a few cents to a few dollars a month; check usage anytime at console.anthropic.com

## Known limitations

- Voice input needs Chrome or Edge — Firefox and Safari don't support the Web Speech API used for listening
- Requires an internet connection at all times; there's no offline mode
- The exact voice/accent you hear depends on what's installed on your device's browser, not something Lumen controls precisely
- Memory is stored per-browser (via localStorage), not synced across devices
- If you use speakers instead of headphones, the mic can occasionally pick up Lumen's own voice and misread it as you talking
