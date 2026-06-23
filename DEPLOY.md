# Deploying Lumen with Supabase

This gives you: a login gate (magic link, no passwords), an allowlist of
approved emails you control from a dashboard table, and an Edge Function that
holds your real Anthropic key server-side so it never reaches the browser.

You'll need: a free Supabase account, an Anthropic API key from
console.anthropic.com (separate from your Claude.ai login — this is billed
per token on your own account), and Node.js installed for the Supabase CLI.

## 1. Create the Supabase project
Go to supabase.com → New project. Pick any name/region. Wait ~2 min for it to spin up.

## 2. Create the approved-users table
Dashboard → SQL Editor → New query → paste the contents of `supabase/setup.sql`
→ Run. Edit the seed emails first, or just run it empty and add people via
Table Editor → `approved_users` → Insert row, anytime, no redeploy needed.

## 3. Install the Supabase CLI and link your project
```bash
npm install -g supabase
supabase login
supabase init
supabase link --project-ref YOUR_PROJECT_REF
```
Your project ref is in the dashboard URL: `supabase.com/dashboard/project/YOUR_PROJECT_REF`

## 4. Deploy the Edge Function
Copy `supabase/functions/lumen-chat/index.ts` from this delivery into that
exact path in your linked project, then:
```bash
supabase functions deploy lumen-chat
```

## 5. Set your Anthropic key as a secret
Run this yourself in your own terminal — never paste your real key into a
chat or commit it to a repo:
```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-your-real-key-here
```

## 6. Get your project's URL and anon key
Dashboard → Project Settings → API. Copy the "Project URL" and the
`anon` `public` key (NOT the service role key — that one stays secret).

Open `index.html` and fill in:
```js
const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
```
The anon key is safe to expose in frontend code — that's what it's for.

## 7. Host the page
Easiest option, no account even needed: go to app.netlify.com/drop and drag
`index.html` onto the page. You'll get a live URL in seconds.
(Vercel or GitHub Pages work too, if you'd rather use those.)

## 8. Allow that URL to receive magic-link redirects
Dashboard → Authentication → URL Configuration → add your new Netlify URL
under "Redirect URLs".

## 9. Try it
Open your hosted URL, sign in with an email you added to `approved_users`,
click the link Supabase emails you, and you're in.

## Managing access afterward
- **Approve someone**: Table Editor → `approved_users` → Insert row with their email.
- **Revoke someone**: delete their row. Their next message gets a 403 instantly — no redeploy.
- **Costs**: Supabase's free tier comfortably covers a handful of users. Anthropic billing is per token — casual chats from a few friends typically run a few cents to a few dollars a month; check usage anytime at console.anthropic.com.
