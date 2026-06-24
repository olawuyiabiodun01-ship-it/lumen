// Deploy path: supabase/functions/lumen-chat/index.ts
// Deploy with:  supabase functions deploy lumen-chat
// Set the secret with:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-your-real-key
//
// This function is the ONLY thing that ever sees your real Anthropic key.
// The browser app never has it.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Tighten this to your real site URL once it's hosted, e.g. "https://your-app.netlify.app"
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) {
      return new Response(JSON.stringify({ error: "missing auth token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Confirm this is a real, currently-valid Supabase session.
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user?.email) {
      return new Response(JSON.stringify({ error: "invalid or expired session" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const email = userData.user.email.toLowerCase();

    // The real gate: is this person on your approved list?
    const { data: approved, error: approvedErr } = await supabase
      .from("approved_users")
      .select("email")
      .eq("email", email)
      .maybeSingle();

    if (approvedErr || !approved) {
      return new Response(
        JSON.stringify({ error: "not approved yet — ask the admin to add this email" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json();

    // ---- BACKGROUND TAGGING MODE ----
    // The frontend fires this after speaking its reply, without waiting on it.
    // It classifies whether a correction happened and logs the category.
    if (body.mode === "tag") {
      const classifyRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 60,
          system: 'You classify whether a German-practice correction happened in this exchange. ' +
            'Reply with ONLY compact JSON, no prose, no markdown: {"mistake":true|false,"category":"short label"}. ' +
            'Categories should be short and reusable, e.g. "der/die/das gender", "verb conjugation", "word order", "case endings", "separable verbs", "adjective endings". ' +
            'If no real German mistake was corrected, return {"mistake":false,"category":""}.',
          messages: [{
            role: "user",
            content: "Person said: " + (body.userText || "") + "\nLumen replied: " + (body.assistantText || ""),
          }],
        }),
      });
      const classifyData = await classifyRes.json();
      const text = (classifyData.content || [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("")
        .trim();

      let parsed = { mistake: false, category: "" };
      try { parsed = JSON.parse(text); } catch (_e) { /* ignore malformed classification, just skip logging */ }

      if (parsed.mistake && parsed.category) {
        await supabase.from("mistake_log").insert({
          user_email: email,
          category: parsed.category,
          example: (body.userText || "").slice(0, 300),
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- NORMAL CHAT MODE ----
    // Check for recent recurring mistakes and gently nudge the system prompt,
    // without an extra LLM call — just one fast table lookup.
    let patternNote = "";
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recent } = await supabase
      .from("mistake_log")
      .select("category")
      .eq("user_email", email)
      .gte("created_at", thirtyDaysAgo);

    if (recent && recent.length) {
      const counts: Record<string, number> = {};
      for (const row of recent) counts[row.category] = (counts[row.category] || 0) + 1;
      const top = Object.entries(counts).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1])[0];
      if (top) {
        patternNote = ` Heads up: this learner has mixed up "${top[0]}" ${top[1]} times recently — if it comes up again, ` +
          `gently point out the pattern as a warm, friendly observation, not a lecture.`;
      }
    }

    const augmentedBody = { ...body, system: (body.system || "") + patternNote };

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(augmentedBody),
    });

    // Stream Anthropic's response straight through so sentence-by-sentence
    // speech still works on the frontend.
    return new Response(anthropicRes.body, {
      status: anthropicRes.status,
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("lumen-chat error:", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
