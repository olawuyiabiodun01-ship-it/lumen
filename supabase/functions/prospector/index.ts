// Deploy path: supabase/functions/prospector/index.ts
// Deploy with:  supabase functions deploy prospector
// Uses the same ANTHROPIC_API_KEY secret you already set for lumen-chat.
//
// This is the "AI SDR" engine. Same auth model as lumen-chat: the browser
// never sees the Anthropic key, and only approved_users can call it.
//
// Modes:
//   analyze  → fetch a company's website, build a company profile + buyer
//              segments, and draft one sample outreach email per segment.
//              (Claude only — no paid data provider needed.)
//   write    → given a specific prospect (name/role/company), write a single
//              personalized outreach email. (Claude only.)
//
// Stages that need external paid services (finding real prospects with real
// emails, and auto-sending on a schedule) are intentionally NOT here yet —
// they plug in as new modes once you add an Apollo/Hunter key and pg_cron.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Stage 2 — real prospect data. Set with:
//   supabase secrets set APOLLO_API_KEY=your-apollo-master-key
// Empty is fine: the "find" / "unlock" modes just report they're not configured
// yet, and Stage 1 (analyze/write) keeps working without it.
const APOLLO_API_KEY = Deno.env.get("APOLLO_API_KEY") || "";
const APOLLO_BASE = "https://api.apollo.io/api/v1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Pull readable text out of a fetched HTML page. Nothing fancy — strip
// scripts/styles/tags, collapse whitespace, and cap the length so we never
// send Claude a giant blob.
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
}

// Normalise whatever the user typed ("stripe.com", "https://stripe.com/pricing")
// into a fetchable https URL, or return null if it's clearly not a domain.
function normaliseUrl(input: string): string | null {
  let s = (input || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

// Turn a human company-size string ("50–500 employees", "1,000+") into the
// "min,max" range format Apollo expects. Returns null if no numbers are found.
function employeeRange(sizeStr: string): string | null {
  const nums = (sizeStr || "").replace(/,/g, "").match(/\d+/g);
  if (!nums || !nums.length) return null;
  if (nums.length === 1) {
    // A single number with a "+" means "that many or more".
    return /\+/.test(sizeStr) ? `${nums[0]},100000` : `${nums[0]},${nums[0]}`;
  }
  return `${nums[0]},${nums[1]}`;
}

// Ask Claude for a JSON object and parse it defensively. Returns null on any
// failure so callers can surface a clean error instead of a 500.
async function claudeJson(system: string, user: string, maxTokens: number) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  const data = await res.json();
  const text = (data.content || [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("")
    .trim();

  const usage = {
    input: data.usage?.input_tokens || 0,
    output: data.usage?.output_tokens || 0,
  };

  // Claude usually returns clean JSON, but strip stray ```json fences just in case.
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return { parsed: JSON.parse(cleaned), usage };
  } catch {
    // Last resort: grab the outermost {...} block.
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return { parsed: JSON.parse(match[0]), usage }; } catch { /* fall through */ }
    }
    return { parsed: null, usage };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // ---- AUTH: same gate as lumen-chat ----
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
    if (!token) return json({ error: "missing auth token" }, 401);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user?.email) return json({ error: "invalid or expired session" }, 401);

    const email = userData.user.email.toLowerCase();
    const { data: approved } = await supabase
      .from("approved_users").select("email").eq("email", email).maybeSingle();
    if (!approved) return json({ error: "not approved yet — ask the admin to add this email" }, 403);

    const body = await req.json();
    const mode = body.mode || "analyze";

    // ---- ANALYZE MODE ----
    // Domain in → company profile + buyer segments + one sample email each.
    if (mode === "analyze") {
      const url = normaliseUrl(body.domain || body.url || "");
      if (!url) return json({ error: "that doesn't look like a valid website" }, 400);

      // Fetch the site. If it blocks us or times out, we still let Claude work
      // from the domain name alone rather than failing outright.
      let siteText = "";
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        const siteRes = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; LumenSDR/1.0)" },
        });
        clearTimeout(timer);
        if (siteRes.ok) siteText = htmlToText(await siteRes.text());
      } catch (_e) { /* proceed with just the domain */ }

      const host = new URL(url).hostname.replace(/^www\./, "");
      const system =
        "You are a B2B go-to-market strategist. Given a company's website text, you infer " +
        "what they sell, who buys it, and how to reach those buyers. Base everything on the " +
        "provided text; where the text is thin, make reasonable, clearly-plausible inferences " +
        "from the domain and industry — never invent specific named customers or fake statistics.\n\n" +
        "Reply with ONLY a JSON object, no prose, no markdown, in exactly this shape:\n" +
        "{\n" +
        '  "company": {"name": string, "one_liner": string, "what_they_sell": string, "category": string},\n' +
        '  "segments": [\n' +
        "    {\n" +
        '      "name": string,                     // short label, e.g. "Mid-market SaaS RevOps"\n' +
        '      "why": string,                       // 1 sentence: why this segment needs the product\n' +
        '      "industry": string,\n' +
        '      "company_size": string,              // e.g. "50–500 employees"\n' +
        '      "decision_makers": [string],         // 2–4 job titles to target\n' +
        '      "pain_points": [string],             // 2–3 concrete pains this product solves\n' +
        '      "signals": [string],                 // 1–3 buying signals to look for (hiring, funding, tech used)\n' +
        '      "sample_email": {"subject": string, "body": string}  // a real, sendable cold email, personalised to the segment, 90 words max\n' +
        "    }\n" +
        "  ]\n" +
        "}\n" +
        "Produce 3–4 segments, ordered best-fit first. Emails must be specific and human, " +
        "no 'I hope this finds you well', no placeholders like [Company].";

      const user =
        `Company website: ${host}\n\n` +
        (siteText
          ? `Website text:\n${siteText}`
          : `(The site could not be fetched. Infer from the domain name "${host}" and general knowledge.)`);

      const { parsed, usage } = await claudeJson(system, user, 3000);
      if (!parsed) return json({ error: "analysis failed — try again in a moment" }, 502);

      // Non-blocking usage logging, same table as lumen-chat.
      supabase.from("token_usage").insert({
        user_email: email,
        input_tokens: usage.input,
        output_tokens: usage.output,
      }).then(() => {}, () => {});

      return json({ ok: true, domain: host, ...parsed });
    }

    // ---- WRITE MODE ----
    // One specific prospect in → one tailored outreach email out.
    if (mode === "write") {
      const p = body.prospect || {};
      const context = body.context || "";
      const system =
        "You write short, sharp, human B2B cold emails that get replies. No fluff, no " +
        "'I hope this finds you well', no fake personalisation. 90 words max. " +
        'Reply with ONLY JSON: {"subject": string, "body": string}.';
      const user =
        `Write a cold email to this person.\n` +
        `Name: ${p.name || "there"}\n` +
        `Role: ${p.role || "unknown"}\n` +
        `Company: ${p.company || "unknown"}\n` +
        `What we sell / why relevant: ${context}`;

      const { parsed, usage } = await claudeJson(system, user, 800);
      if (!parsed) return json({ error: "email generation failed" }, 502);

      supabase.from("token_usage").insert({
        user_email: email,
        input_tokens: usage.input,
        output_tokens: usage.output,
      }).then(() => {}, () => {});

      return json({ ok: true, email: parsed });
    }

    // ---- FIND MODE (Stage 2) ----
    // One buyer segment in → real people (name, title, company, LinkedIn) out.
    // Uses Apollo's search endpoint, which is FREE and returns NO emails.
    // Emails are unlocked separately, per-person, via the "unlock" mode below.
    if (mode === "find") {
      if (!APOLLO_API_KEY) {
        return json({ error: "Apollo isn't connected yet — set the APOLLO_API_KEY secret to turn on prospect-finding." }, 400);
      }
      const seg = body.segment || {};
      const titles = (seg.decision_makers || []).filter(Boolean).slice(0, 6);
      if (!titles.length) return json({ error: "this segment has no target job titles" }, 400);

      const payload: Record<string, unknown> = {
        person_titles: titles,
        page: 1,
        per_page: Math.min(Math.max(Number(body.per_page) || 10, 1), 25),
      };
      if (seg.industry) payload.q_keywords = seg.industry;
      const range = employeeRange(seg.company_size || "");
      if (range) payload.organization_num_employees_ranges = [range];

      const apolloRes = await fetch(`${APOLLO_BASE}/mixed_people/api_search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "X-Api-Key": APOLLO_API_KEY,
        },
        body: JSON.stringify(payload),
      });
      const data = await apolloRes.json().catch(() => ({}));
      if (!apolloRes.ok) {
        const msg = data?.error || data?.message || `HTTP ${apolloRes.status}`;
        return json({ error: "Apollo search failed: " + msg }, 502);
      }

      const people = (data.people || []).map((p: any) => ({
        id: p.id,
        name: p.name || [p.first_name, p.last_name].filter(Boolean).join(" "),
        title: p.title || "",
        company: p.organization?.name || "",
        domain: p.organization?.primary_domain || p.organization?.website_url || "",
        linkedin: p.linkedin_url || "",
      }));
      const total = data.pagination?.total_entries ?? people.length;
      return json({ ok: true, people, total });
    }

    // ---- UNLOCK MODE (Stage 2, costs one Apollo credit) ----
    // Reveal one prospect's verified email. Only ever runs on an explicit
    // per-person action from the UI, so credits are never spent by surprise.
    if (mode === "unlock") {
      if (!APOLLO_API_KEY) return json({ error: "Apollo isn't connected yet." }, 400);
      const id = body.id;
      if (!id) return json({ error: "missing prospect id" }, 400);

      const apolloRes = await fetch(`${APOLLO_BASE}/people/match`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "X-Api-Key": APOLLO_API_KEY,
        },
        body: JSON.stringify({ id, reveal_personal_emails: true }),
      });
      const data = await apolloRes.json().catch(() => ({}));
      if (!apolloRes.ok) {
        const msg = data?.error || data?.message || `HTTP ${apolloRes.status}`;
        return json({ error: "Apollo enrichment failed: " + msg }, 502);
      }

      const person = data.person || {};
      const email =
        person.email ||
        (person.personal_emails && person.personal_emails[0]) ||
        (person.contact_emails && person.contact_emails[0]?.email) ||
        "";
      const phone = (person.phone_numbers && person.phone_numbers[0]?.sanitized_number) || "";
      return json({ ok: true, email, phone });
    }

    return json({ error: "unknown mode" }, 400);
  } catch (e) {
    console.error("prospector error:", e);
    return json({ error: String(e) }, 500);
  }
});
