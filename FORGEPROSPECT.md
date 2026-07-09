# ForgeProspect — by JayQue

**Understand your market before you contact it.**

ForgeProspect studies your business and identifies the organizations you can *genuinely help* — not everyone, the right ones. It builds decision profiles, prepares an intelligence brief on each target, finds real decision-makers with verified emails, drafts courteous outreach, and sends it on a schedule with follow-ups — with **you reviewing every step** before anything goes out.

Its philosophy is **fit over conversion**: the goal isn't to close everyone, it's to find the organizations whose real problems you're well-placed to solve.

It's an installable web app (PWA), invite-only, running on your own Supabase project and API keys.

---

## What it does

ForgeProspect runs a reviewable outbound pipeline. Nothing is sent without your explicit approval.

1. **Analyze** — enter your company's website. It reads the site and builds a company profile plus 3–4 **decision profiles**: distinct types of organization you can genuinely help, each with target industries, company sizes, decision-maker roles, the challenges you're placed to solve, and good-fit signals.
2. **Find** — for each profile it discovers real companies (via live web search, steerable by region), then finds decision-makers with **verified emails** through Hunter.io. If a company isn't in Hunter, it falls back to scraping the company's own site for a published contact address.
3. **Understand** — for any target, generate an **Executive Intelligence Brief** *before* writing: organization summary, why they match you, estimated digital maturity, likely operational challenges, likely AI concerns, decision-makers, conversation starters, and a recommended next step. Every outreach begins from understanding.
4. **Write** — drafts a warm, courteous, personalized email that opens with a genuine pleasantry and invites the recipient to visit your website.
5. **Send & follow up** — add prospects to your **Outbox**, approve them, and the scheduler sends via Resend and runs automatic follow-ups (+3 and +7 days). Replies and unsubscribes stop the sequence.

### Highlights

- **You approve every send.** Prospects enter as drafts; nothing leaves until you approve it.
- **Compliant by default.** Every email carries an unsubscribe link and your physical address (CAN-SPAM), with a per-user daily send cap to protect your domain reputation.
- **Region-aware discovery.** A "Where to hunt for leads" control steers search toward a country/city (built with African B2B + SMB markets in mind).
- **CSV export.** Download found prospects for your CRM in one click.
- **Outbox dashboard.** Live counts of prospects, drafts, scheduled, sent, and replied.
- **Team access.** Admin can invite colleagues from inside the app; email + password login (no magic-link waits).
- **Installable.** Add it to a phone or desktop like a native app.

---

## Architecture

```
Browser (prospector.html — single-file HTML/JS, no build step, PWA)
   │  email + password login
   ▼
Supabase Auth  ── approved_users allowlist ──►  who may use the app
   │  authenticated request (Bearer token)
   ▼
Supabase Edge Function: prospector
   │  the only place the API keys live; verifies the session on every call
   ├── Anthropic (Claude)     → analyze, write buyer segments & emails
   ├── Serper.dev (Google)    → live company discovery
   ├── Hunter.io              → verified decision-maker emails
   └── website scraping       → fallback contact emails
   ▼
Supabase Postgres  (outreach queue, sender settings, suppression list)
   ▲
   │  polled every 5 min by pg_cron
Supabase Edge Function: outreach-cron
   └── Resend  → sends approved emails + follow-ups, with a compliant footer
```

### Services used

| Service | Role | Notes |
|---|---|---|
| **Supabase** | Auth, Postgres, Edge Functions | Free tier is ample for a small team |
| **Anthropic (Claude)** | Analysis + email writing | `claude-sonnet-4-6`, billed per token |
| **Hunter.io** | Verified emails | Free tier ≈ 25 lookups/month |
| **Serper.dev** | Live web search for discovery | Free tier ≈ 2,500 searches/month |
| **Resend** | Email delivery | Free tier 3,000/month, 100/day; sender domain must be verified |

---

## File layout

```
prospector.html                       → the app (served by GitHub Pages)
sdr-manifest.json                     → PWA manifest (install metadata)
sw.js                                  → service worker (installability)
logo/logo-1-tile.svg                   → JayQue brand logo
icon-192.png / icon-512.png            → PWA icons
supabase/
├── outreach-setup.sql                 → outreach tables + pg_cron schedule
└── functions/
    ├── prospector/index.ts            → the pipeline engine (all modes)
    └── outreach-cron/index.ts         → the scheduled sender
```

The `prospector` function handles every interactive action via a `mode` field: `analyze`, `brief`, `write`, `find`, `queue`, `outbox`, `approve`, `pause`, `resume`, `mark_replied`, `settings_get/save`, `test_send`, and admin `admin_list_users/add_user/remove_user`, plus a public `?u=<token>` unsubscribe route.

### Roadmap — the Knowledge Engine

The Executive Intelligence Brief produces explicit **predictions** (estimated maturity, likely challenges, likely concerns). The intended next step is a feedback loop with **ForgeScale**: as real engagements confirm or disprove those predictions, prediction accuracy improves over time — turning accumulated outcomes into JayQue's durable competitive advantage. The brief's structured output is designed to feed that loop.

---

## Setup

### 1. Secrets

Set these on your Supabase project (`supabase secrets set NAME=value`):

| Secret | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude — analysis & email writing |
| `HUNTER_API_KEY` | Hunter.io — verified emails |
| `SERPER_API_KEY` | Serper.dev — live web search (optional; falls back to Claude's knowledge if unset) |
| `RESEND_API_KEY` | Resend — sending |
| `CRON_SECRET` | Shared secret the scheduler authenticates with (any long random string) |
| `ADMIN_EMAIL` | *(optional)* who can invite teammates; defaults to the project admin |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by the platform.

### 2. Database

Run `supabase/outreach-setup.sql` in the Supabase SQL Editor. It creates the `outreach`, `sender_settings`, and `unsubscribes` tables. (The `approved_users` and `token_usage` tables are shared with the rest of the project.)

### 3. Deploy the functions

```bash
supabase functions deploy prospector   --no-verify-jwt
supabase functions deploy outreach-cron --no-verify-jwt
```

`--no-verify-jwt` is required so the public unsubscribe link works. Security is unaffected — every interactive action still verifies a valid, approved session in-code.

### 4. Schedule the sender

In `outreach-setup.sql`, fill in your project ref and `CRON_SECRET` in the `cron.schedule(...)` block and run it. It pokes `outreach-cron` every 5 minutes (it only sends what's approved and due).

### 5. Host the front-end

Enable **GitHub Pages** on the repo (Settings → Pages → deploy from `main`). The app is then live at:

```
https://<your-username>.github.io/<repo>/prospector.html
```

### 6. Configure sending identity

Open the app → **Outbox → Sending identity & compliance**:

- **From email** — an address on a domain you've **verified in Resend** (e.g. `hello@yourdomain.com`). It doesn't need to be a real inbox to *send*.
- **Reply-to** — a real inbox you check, so prospect replies land somewhere.
- **Physical address** — required by anti-spam law; appears in the footer.

Use **"Send test email to me"** to confirm sending works before running real outreach.

---

## Managing access

The app is invite-only. As admin, open the **Team** tab, add a colleague's email, and send them the app link. They sign in with email + password (the `approved_users` allowlist is the real gate — passwords don't bypass it). Remove anyone anytime from the same tab.

> **Password login note:** turn **off** "Confirm email" in Supabase → Authentication → Email so sign-ups are instant. Accounts created before the switch to passwords set one via **Forgot password?** once.

---

## Costs

All usage runs on your own accounts:

- **Supabase / Hunter / Serper / Resend** — free tiers cover light, real-world use.
- **Anthropic** — billed per token; typically cents to a few dollars for normal use.
- Every teammate's activity draws on these same keys, so keep the daily cap and free-tier limits in mind as you add users.

---

## Known limitations

- **Reply detection is manual.** You mark a sequence as replied when you see a response; automatic inbound-reply detection would need Resend inbound routing (a possible future addition). Unsubscribes and bounces are handled automatically.
- **Hunter's free tier is small** (~25 lookups/month). The website-scraping fallback and CSV export ease this, but high volume needs a paid plan.
- **Discovery quality depends on search.** Without `SERPER_API_KEY`, company discovery falls back to Claude's own knowledge, which is thinner for niche, local, or very new companies.
- **Sending requires a verified domain** in Resend; you can't send from a free provider like Gmail.

---

## Safety & compliance built in

- Nothing sends until a prospect is **explicitly approved**.
- **Unsubscribe link** in every email, honored globally via a suppression list.
- **Physical address** in every footer (CAN-SPAM).
- **Daily send cap** per user to protect deliverability.
- API keys never touch the browser — they live only in the Edge Functions.
