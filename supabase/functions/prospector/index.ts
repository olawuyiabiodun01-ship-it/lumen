// Deploy path: supabase/functions/prospector/index.ts
// Deploy with:  supabase functions deploy prospector --no-verify-jwt
//   (--no-verify-jwt lets the PUBLIC unsubscribe link — an unauthenticated GET
//    — reach this function. It does NOT weaken security: every POST mode below
//    still does its own full auth (valid session + approved_users) and rejects
//    anything without a real, approved session.)
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
//   find     → Stage 2: real prospects + verified emails via Hunter.io.
//   queue / outbox / approve / pause / resume / mark_replied
//            → Stage 4: build & manage an outreach queue. Nothing here sends
//              email — approve only marks rows 'approved'; the separate
//              outreach-cron function does the actual sending.
//   settings_get / settings_save → per-user sending identity + compliance.
//   (plus a public GET ?u=<token> unsubscribe handler, before the auth gate.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Stage 2 — real prospect data via Hunter.io (works on Hunter's free tier).
// Set with:  supabase secrets set HUNTER_API_KEY=your-hunter-key
// Empty is fine: the "find" mode just reports it's not configured yet, and
// Stage 1 (analyze/write) keeps working without it.
const HUNTER_API_KEY = Deno.env.get("HUNTER_API_KEY") || "";
const HUNTER_BASE = "https://api.hunter.io/v2";

// Optional: live web search to WIDEN where we look for companies, instead of
// relying on Claude's memory (which is thin for African / niche / new firms).
// Serper.dev gives Google results with a generous free tier (~2,500 queries).
//   supabase secrets set SERPER_API_KEY=your-serper-key
// If unset, "find" quietly falls back to Claude's own knowledge.
const SERPER_API_KEY = Deno.env.get("SERPER_API_KEY") || "";

// Only this email can invite/remove teammates. Same default + override as
// lumen-chat, so both apps share one admin.
const ADMIN_EMAIL = (Deno.env.get("ADMIN_EMAIL") || "olawuyiabiodun01@gmail.com").toLowerCase();

// Directories/marketplaces/socials that clog search results — never treat these
// as target companies to email.
const AGGREGATOR_DOMAINS = [
  "linkedin.com", "facebook.com", "instagram.com", "twitter.com", "x.com",
  "wikipedia.org", "crunchbase.com", "glassdoor.com", "indeed.com", "youtube.com",
  "yelp.com", "yellowpages.com", "tripadvisor.com", "medium.com", "reddit.com",
  "amazon.com", "google.com", "bloomberg.com", "pitchbook.com", "zoominfo.com",
  "clutch.co", "trustpilot.com", "businesslist.com.ng", "vconnect.com",
];
function isAggregator(domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, "");
  return AGGREGATOR_DOMAINS.some((a) => d === a || d.endsWith("." + a));
}

// Run a Google search via Serper and return organic {title, link, snippet}.
async function serperSearch(query: string, gl?: string): Promise<any[]> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: 20, ...(gl ? { gl } : {}) }),
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.organic) ? data.organic : [];
}

// Best-effort map of a typed location to a Google country code, to bias results.
const GL_BY_COUNTRY: Record<string, string> = {
  nigeria: "ng", ghana: "gh", kenya: "ke", "south africa": "za", egypt: "eg",
  tanzania: "tz", uganda: "ug", rwanda: "rw", ethiopia: "et", morocco: "ma",
  "ivory coast": "ci", "cote d'ivoire": "ci", senegal: "sn", cameroon: "cm",
};
function glFor(location: string): string | undefined {
  const l = location.toLowerCase();
  for (const [name, gl] of Object.entries(GL_BY_COUNTRY)) if (l.includes(name)) return gl;
  return undefined;
}

// Addresses that are never a real human contact (system/asset/placeholder).
const EMAIL_NOISE =
  /(no-?reply|do-?not-?reply|example\.|sentry|wixpress|@2x|\.(png|jpg|jpeg|gif|webp|svg)|wordpress|placeholder|yourdomain|your-?email|domain\.com|test@|@email\.|u003e|u003c)/i;
const GENERIC_LOCALPARTS = ["info", "hello", "contact", "sales", "admin", "support", "hi", "team", "enquiries", "enquiry", "office", "mail", "hey"];

async function fetchText(url: string, ms = 8000): Promise<string> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; LumenSDR/1.0)" },
    });
    clearTimeout(t);
    if (!res.ok) return "";
    return await res.text();
  } catch { return ""; }
}

// Fallback email source for SMBs that Hunter doesn't index: scrape the company's
// own site (home + common contact pages) for published addresses. No API needed.
async function scrapeCompanyEmails(domain: string): Promise<any[]> {
  const base = `https://${domain}`;
  const paths = ["", "/contact", "/contact-us", "/about", "/about-us"];
  const found = new Set<string>();
  for (const p of paths) {
    if (found.size >= 3) break;
    const html = await fetchText(base + p);
    if (!html) continue;
    // Also catch "mailto:" and obfuscated "name (at) domain" is out of scope; keep it simple.
    const matches = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    for (const raw of matches) {
      const e = raw.toLowerCase();
      if (EMAIL_NOISE.test(e)) continue;
      const edom = e.split("@")[1] || "";
      const onDomain = edom === domain || edom.endsWith("." + domain) || domain.endsWith("." + edom);
      const freeProvider = /^(gmail|yahoo|outlook|hotmail|icloud|proton(mail)?)\./.test(edom) ||
        /(gmail|yahoo|outlook|hotmail|icloud|protonmail)\.com$/.test(edom);
      if (!onDomain && !freeProvider) continue;
      found.add(e);
      if (found.size >= 3) break;
    }
  }
  return [...found].map((e) => {
    const local = e.split("@")[0];
    const generic = GENERIC_LOCALPARTS.includes(local);
    return {
      name: generic ? "(company inbox)" : local.replace(/[._-]+/g, " "),
      title: "",
      email: e,
      linkedin: "",
      confidence: null,
      via: "website",
    };
  });
}

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

  // ---- PUBLIC UNSUBSCRIBE (no auth) ----
  // Recipients click the ?u=<token> link in an email footer. The token is just
  // their base64url-encoded email. We add them to the suppression list and stop
  // any of their pending sequences, then show a plain confirmation page.
  const reqUrl = new URL(req.url);
  const unsubToken = reqUrl.searchParams.get("u");
  if (req.method === "GET" && unsubToken) {
    let target = "";
    try {
      target = atob(unsubToken.replace(/-/g, "+").replace(/_/g, "/")).trim().toLowerCase();
    } catch { /* bad token */ }
    const page = (msg: string) =>
      new Response(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:460px;margin:80px auto;padding:0 20px;text-align:center;color:#1a1a1a">` +
        `<h2>${msg}</h2></div>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    if (!target || !target.includes("@")) return page("Invalid unsubscribe link.");
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await admin.from("unsubscribes").upsert({ email: target }, { onConflict: "email" });
    await admin.from("outreach").update({ status: "unsubscribed" })
      .eq("prospect_email", target).in("status", ["draft", "approved", "paused"]);
    return page("You've been unsubscribed. You won't receive further emails.");
  }

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
        "Produce 3–4 segments, ordered best-fit first. Emails must open with a brief, genuine, " +
        "courteous greeting (by first name if one is given, otherwise a warm general greeting) " +
        "before making the point — polite, not abrupt or salesy. Avoid empty filler like " +
        "'I hope this finds you well', and no placeholders like [Company].";

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
        "You write short, warm, human B2B cold emails that get replies. Open with a brief, " +
        "genuine, courteous greeting — by first name if one is given, otherwise a warm general " +
        "greeting — before making the point. Be polite throughout, never abrupt. Avoid empty " +
        "filler like 'I hope this finds you well', and no fake personalisation. 90 words max. " +
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

    // ---- FIND MODE (Stage 2, Hunter.io free tier) ----
    // Two stages: (1) Claude names real companies that fit the segment, then
    // (2) Hunter's Domain Search returns real decision-makers WITH verified
    // emails at each. Hunter only counts a search when it returns ≥1 result,
    // so empty companies don't burn quota.
    if (mode === "find") {
      if (!HUNTER_API_KEY) {
        return json({ error: "Hunter isn't connected yet — set the HUNTER_API_KEY secret to turn on prospect-finding." }, 400);
      }
      const seg = body.segment || {};
      const location = (body.location || "").trim();
      // Keep this small: each company is one Hunter lookup, and the free tier
      // is ~25/month. Default 3, hard cap 6.
      const count = Math.min(Math.max(Number(body.count) || 3, 1), 6);
      const sellerContext = body.seller ? `The product being sold: ${body.seller}. ` : "";

      let companies: any[] = [];
      let usage = { input: 0, output: 0 };
      let source = "knowledge";

      // Stage 1a — if search is configured, WIDEN discovery with live Google
      // results and let Claude pick real companies out of them. This is what
      // reaches African / niche / newer firms Claude wouldn't recall from memory.
      if (SERPER_API_KEY) {
        const where = location ? ` in ${location}` : "";
        const query = `${seg.industry || seg.name || "B2B"} companies${where}`;
        const organic = await serperSearch(query, glFor(location));
        const results = organic
          .filter((r: any) => r.link)
          .map((r: any) => {
            let dom = "";
            try { dom = new URL(r.link).hostname.replace(/^www\./, ""); } catch { /* skip */ }
            return { title: r.title || "", snippet: r.snippet || "", domain: dom };
          })
          .filter((r: any) => r.domain && !isAggregator(r.domain));

        if (results.length) {
          const extractSystem =
            "You are a B2B researcher. From the SEARCH RESULTS provided, pick the real, " +
            "currently-operating companies that best fit the buyer segment as CUSTOMERS. " +
            "Use only companies actually present in the results, with the domain shown for each. " +
            "Skip directories, marketplaces, blogs, news sites and job boards.\n" +
            `Reply with ONLY JSON: {"companies":[{"name": string, "domain": string}]}. Up to ${count}, best fit first.`;
          const extractUser =
            sellerContext +
            `Segment: ${seg.name || ""}\nIndustry: ${seg.industry || ""}\n` +
            `Location focus: ${location || "any"}\nWhy they fit: ${seg.why || ""}\n\n` +
            "SEARCH RESULTS:\n" +
            results.slice(0, 20).map((r: any, i: number) =>
              `${i + 1}. ${r.title} [${r.domain}] — ${r.snippet}`).join("\n");
          const out = await claudeJson(extractSystem, extractUser, 700);
          companies = (out.parsed?.companies || []).filter((c: any) => c && c.domain);
          usage = out.usage;
          source = "search";
        }
      }

      // Stage 1b — fallback (no search key, or search returned nothing usable):
      // Claude proposes companies from its own knowledge, as before.
      if (!companies.length) {
        const where = location ? ` Focus on companies in ${location}.` : "";
        const compSystem =
          "You are a B2B researcher. Given a buyer segment, name real, currently-operating " +
          "companies that are a strong fit as CUSTOMERS for the product. Use only real companies " +
          "you are confident exist, with their real primary web domain. Never invent companies or domains." +
          where + "\n" +
          `Reply with ONLY JSON: {"companies":[{"name": string, "domain": string}]}. Give up to ${count}.`;
        const compUser =
          sellerContext +
          `Segment: ${seg.name || ""}\nIndustry: ${seg.industry || ""}\n` +
          `Company size: ${seg.company_size || ""}\nWhy they fit: ${seg.why || ""}\n` +
          `Target roles: ${(seg.decision_makers || []).join(", ")}`;
        const out = await claudeJson(compSystem, compUser, 700);
        companies = (out.parsed?.companies || []).filter((c: any) => c && c.domain);
        usage = out.usage;
        source = "knowledge";
      }

      companies = companies.filter((c: any) => !isAggregator(String(c.domain))).slice(0, count);
      if (!companies.length) return json({ error: "couldn't identify target companies for this segment" }, 502);

      supabase.from("token_usage").insert({
        user_email: email, input_tokens: usage.input, output_tokens: usage.output,
      }).then(() => {}, () => {});

      // Stage 2 — Hunter Domain Search per company. Sequential to stay gentle on
      // the free rate limit; failures on one company don't sink the others.
      const people: any[] = [];
      let lookupsCounted = 0;
      let scrapedCount = 0;
      for (const co of companies) {
        const domain = String(co.domain).replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim();
        if (!domain) continue;
        let gotFromHunter = false;
        try {
          const url = `${HUNTER_BASE}/domain-search?domain=${encodeURIComponent(domain)}&type=personal&limit=10`;
          const hRes = await fetch(url, { headers: { "X-API-KEY": HUNTER_API_KEY } });
          const hData = await hRes.json().catch(() => ({}));
          if (!hRes.ok) {
            // Surface auth/quota errors clearly instead of silently returning nothing.
            const detail = hData?.errors?.[0]?.details || `HTTP ${hRes.status}`;
            if (hRes.status === 401 || hRes.status === 429) {
              return json({ error: "Hunter: " + detail }, 502);
            }
          } else {
            const emails = hData?.data?.emails || [];
            if (emails.length) { lookupsCounted++; gotFromHunter = true; }
            // Prefer decision-makers: senior/executive first, then by confidence.
            const rank = (e: any) => (e.seniority === "executive" ? 0 : e.seniority === "senior" ? 1 : 2);
            emails
              .filter((e: any) => e.value)
              .sort((a: any, b: any) => rank(a) - rank(b) || (b.confidence || 0) - (a.confidence || 0))
              .slice(0, 5)
              .forEach((e: any) => {
                people.push({
                  name: [e.first_name, e.last_name].filter(Boolean).join(" "),
                  title: e.position || "",
                  company: co.name || domain,
                  email: e.value,
                  linkedin: e.linkedin || "",
                  confidence: e.confidence ?? null,
                  via: "hunter",
                });
              });
          }
        } catch (_e) { /* fall through to scraping */ }

        // Fallback: Hunter had nothing (common for African SMBs). Scrape the
        // company's own site for a published contact address. Costs no quota.
        if (!gotFromHunter) {
          const scraped = await scrapeCompanyEmails(domain);
          scraped.forEach((s) => { people.push({ ...s, company: co.name || domain }); scrapedCount++; });
        }
      }

      return json({
        ok: true,
        people,
        companies: companies.map((c: any) => c.name || c.domain),
        lookups_used: lookupsCounted,
        scraped: scrapedCount, // emails pulled from company websites as a fallback
        source, // "search" (live web) or "knowledge" (Claude's memory)
      });
    }

    // ================= STAGE 4: OUTREACH / AUTO-SEND =================

    // ---- SENDER SETTINGS ----
    if (mode === "settings_get") {
      const { data } = await supabase.from("sender_settings").select("*").eq("user_email", email).maybeSingle();
      return json({ ok: true, settings: data || null });
    }
    if (mode === "settings_save") {
      const s = body.settings || {};
      const row = {
        user_email: email,
        from_name: (s.from_name || "").trim() || null,
        from_email: (s.from_email || "").trim().toLowerCase() || null,
        reply_to: (s.reply_to || "").trim().toLowerCase() || null,
        signature: (s.signature || "").trim() || null,
        physical_address: (s.physical_address || "").trim() || null,
        daily_cap: Math.min(Math.max(Number(s.daily_cap) || 50, 1), 500),
        updated_at: new Date().toISOString(),
      };
      const { error: upErr } = await supabase.from("sender_settings").upsert(row, { onConflict: "user_email" });
      if (upErr) return json({ error: upErr.message }, 500);
      return json({ ok: true });
    }

    // ---- QUEUE: add prospects as DRAFTS (never sends anything) ----
    if (mode === "queue") {
      const items = Array.isArray(body.prospects) ? body.prospects : [];
      if (!items.length) return json({ error: "no prospects to queue" }, 400);
      const rows = items
        .filter((p: any) => p && p.email && p.subject && p.body)
        .slice(0, 100)
        .map((p: any) => ({
          user_email: email,
          sequence_id: crypto.randomUUID(),
          step: 0,
          prospect_name: p.name || null,
          prospect_email: String(p.email).trim().toLowerCase(),
          prospect_company: p.company || null,
          prospect_title: p.title || null,
          segment_name: p.segment || null,
          subject: p.subject,
          body: p.body,
          status: "draft",
        }));
      if (!rows.length) return json({ error: "prospects were missing email/subject/body" }, 400);
      const { error: insErr } = await supabase.from("outreach").insert(rows);
      if (insErr) return json({ error: insErr.message }, 500);
      return json({ ok: true, queued: rows.length });
    }

    // ---- OUTBOX: list this user's outreach rows ----
    if (mode === "outbox") {
      const { data, error: obErr } = await supabase
        .from("outreach").select("*").eq("user_email", email)
        .order("created_at", { ascending: false }).limit(300);
      if (obErr) return json({ error: obErr.message }, 500);
      return json({ ok: true, rows: data || [] });
    }

    // ---- APPROVE: schedule drafts to send, optionally with follow-ups ----
    // This is the ONLY thing that lets an email leave the building. Even then
    // it only sets status='approved' + a send time; the cron does the sending.
    if (mode === "approve") {
      const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
      if (!ids.length) return json({ error: "no ids to approve" }, 400);
      const sendAt = body.send_at ? new Date(body.send_at) : new Date();
      const followups = body.followups !== false; // default on
      const days: number[] = Array.isArray(body.followup_days) ? body.followup_days : [3, 7];

      // Load the drafts we're approving (must belong to this user + be step 0 drafts).
      const { data: drafts } = await supabase
        .from("outreach").select("*").eq("user_email", email).eq("status", "draft").in("id", ids);
      if (!drafts || !drafts.length) return json({ error: "nothing approvable in that selection" }, 400);

      // Approve the initial emails.
      await supabase.from("outreach")
        .update({ status: "approved", send_after: sendAt.toISOString() })
        .in("id", drafts.map((d: any) => d.id));

      // Generate templated follow-ups in the same sequence, pre-approved but
      // clearly spaced out. A reply/unsubscribe cancels them (see mark_replied).
      let followupCount = 0;
      if (followups) {
        const extra: any[] = [];
        for (const d of drafts) {
          const first = (d.prospect_name || "there").split(" ")[0];
          days.slice(0, 2).forEach((offset, i) => {
            const when = new Date(sendAt.getTime() + offset * 24 * 60 * 60 * 1000);
            const body2 = i === 0
              ? `Hi ${first},\n\nFloating this back to the top of your inbox in case it slipped by — I know these things get buried.\n\nWorth a quick look?`
              : `Hi ${first},\n\nLast note from me on this — if it's not the right time, no problem at all. If it is, I'm happy to share a bit more whenever suits.`;
            extra.push({
              user_email: email,
              sequence_id: d.sequence_id,
              step: i + 1,
              prospect_name: d.prospect_name,
              prospect_email: d.prospect_email,
              prospect_company: d.prospect_company,
              prospect_title: d.prospect_title,
              segment_name: d.segment_name,
              subject: d.subject.startsWith("Re:") ? d.subject : `Re: ${d.subject}`,
              body: body2,
              status: "approved",
              send_after: when.toISOString(),
            });
          });
        }
        if (extra.length) {
          const { error: fErr } = await supabase.from("outreach").insert(extra);
          if (!fErr) followupCount = extra.length;
        }
      }
      return json({ ok: true, approved: drafts.length, followups: followupCount });
    }

    // ---- PAUSE / RESUME / MARK REPLIED — act on a whole sequence ----
    if (mode === "pause") {
      if (!body.sequence_id) return json({ error: "missing sequence_id" }, 400);
      await supabase.from("outreach").update({ status: "paused" })
        .eq("user_email", email).eq("sequence_id", body.sequence_id).in("status", ["approved", "draft"]);
      return json({ ok: true });
    }
    if (mode === "resume") {
      if (!body.sequence_id) return json({ error: "missing sequence_id" }, 400);
      await supabase.from("outreach").update({ status: "approved" })
        .eq("user_email", email).eq("sequence_id", body.sequence_id).eq("status", "paused");
      return json({ ok: true });
    }
    if (mode === "mark_replied") {
      if (!body.sequence_id) return json({ error: "missing sequence_id" }, 400);
      // Stop everything still pending in the sequence; leave already-sent rows.
      await supabase.from("outreach").update({ status: "replied" })
        .eq("user_email", email).eq("sequence_id", body.sequence_id).in("status", ["draft", "approved", "paused"]);
      return json({ ok: true });
    }

    // ---- TEAM ACCESS (admin only) — invite colleagues to the app ----
    if (mode === "admin_list_users" || mode === "admin_add_user" || mode === "admin_remove_user") {
      if (email !== ADMIN_EMAIL) return json({ error: "admin only" }, 403);

      if (mode === "admin_list_users") {
        const { data, error: e } = await supabase
          .from("approved_users").select("email, added_at").order("added_at", { ascending: false });
        if (e) return json({ error: e.message }, 500);
        return json({ ok: true, users: data || [], admin_email: ADMIN_EMAIL });
      }

      if (mode === "admin_add_user") {
        const newEmail = (body.email || "").trim().toLowerCase();
        if (!newEmail.includes("@")) return json({ error: "invalid email" }, 400);
        const { error: e } = await supabase.from("approved_users").insert({ email: newEmail });
        if (e && e.code !== "23505") return json({ error: e.message }, 500); // 23505 = already there
        return json({ ok: true });
      }

      // admin_remove_user
      const target = (body.email || "").trim().toLowerCase();
      if (!target) return json({ error: "invalid email" }, 400);
      if (target === ADMIN_EMAIL) return json({ error: "can't remove the admin" }, 400);
      const { error: e } = await supabase.from("approved_users").delete().eq("email", target);
      if (e) return json({ error: e.message }, 500);
      return json({ ok: true });
    }

    return json({ error: "unknown mode" }, 400);
  } catch (e) {
    console.error("prospector error:", e);
    return json({ error: String(e) }, 500);
  }
});
