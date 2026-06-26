// Deploy path: supabase/functions/lumen-chat/index.ts
// Deploy with:  supabase functions deploy lumen-chat
// Set the secret with:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-your-real-key
//
// This function is the ONLY thing that ever sees your real Anthropic key.
// The browser app never has it.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// EdgeRuntime exists as a real global in Supabase's runtime; this declaration
// just keeps editors/type-checkers from flagging it as unknown.
declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void };

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Your ElevenLabs key — set with: supabase secrets set ELEVENLABS_API_KEY=...
const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY")!;
// Default is "Rachel", a stable ElevenLabs premade voice that handles German
// and English well via the multilingual model. Swap to any voice_id from
// your own Voice Library by setting an ELEVENLABS_VOICE_ID secret instead.
const ELEVENLABS_VOICE_ID = Deno.env.get("ELEVENLABS_VOICE_ID") || "21m00Tcm4TlvDq8ikWAM";

// Only this email can see per-user token usage. Override anytime by setting
// an ADMIN_EMAIL secret instead, without touching this code.
const ADMIN_EMAIL = (Deno.env.get("ADMIN_EMAIL") || "olawuyiabiodun01@gmail.com").toLowerCase();

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

    // ---- TEXT-TO-SPEECH MODE ----
    // Converts one sentence to natural multilingual speech via ElevenLabs.
    // Returns raw audio bytes; the frontend falls back to the browser's
    // built-in voice if this fails for any reason.
    if (body.mode === "tts") {
      const text = (body.text || "").trim();
      if (!text) {
        return new Response(JSON.stringify({ error: "missing text" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Allows the frontend to pick a different voice per practice language
      // (e.g. a Yoruba-accented voice) without needing a separate function.
      const voiceId = body.voiceId || ELEVENLABS_VOICE_ID;

      const elevenRes = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": ELEVENLABS_API_KEY,
            "Accept": "audio/mpeg",
          },
          body: JSON.stringify({
            text,
            model_id: "eleven_multilingual_v2",
            voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 0.92 },
          }),
        },
      );

      if (!elevenRes.ok) {
        const errText = await elevenRes.text().catch(() => "");
        return new Response(
          JSON.stringify({ error: "ElevenLabs TTS failed: " + errText.slice(0, 200) }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      return new Response(elevenRes.body, {
        headers: { ...corsHeaders, "Content-Type": "audio/mpeg" },
      });
    }

    // ---- BACKGROUND TAGGING MODE ----
    // The frontend fires this after speaking its reply, without waiting on it.
    // It classifies whether a correction happened and logs the category.
    if (body.mode === "tag") {
      const practiceLang = body.language === "yo" ? "Yoruba" : "German";
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
          system: 'You classify whether a ' + practiceLang + '-practice correction happened in this exchange. ' +
            'Reply with ONLY compact JSON, no prose, no markdown: {"mistake":true|false,"category":"short label"}. ' +
            'Categories should be short and reusable — pick whatever grammatical category fits the language, e.g. for German: "der/die/das gender", "verb conjugation", "word order"; for Yoruba: "tone/pitch", "vowel length", "verb particle". ' +
            'If no real ' + practiceLang + ' mistake was corrected, return {"mistake":false,"category":""}.',
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
          language: body.language === "yo" ? "yo" : "de",
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- ADMIN USAGE MODE ----
    // Only the designated admin email can see this. Everyone else gets a 403,
    // even if they somehow trigger this request directly.
    if (body.mode === "admin_usage") {
      if (email !== ADMIN_EMAIL) {
        return new Response(JSON.stringify({ error: "admin only" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: rows, error: rowsErr } = await supabase
        .from("token_usage")
        .select("user_email, input_tokens, output_tokens");

      if (rowsErr) {
        return new Response(JSON.stringify({ error: rowsErr.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const summary: Record<string, { input: number; output: number; messages: number }> = {};
      for (const row of rows || []) {
        const key = row.user_email;
        if (!summary[key]) summary[key] = { input: 0, output: 0, messages: 0 };
        summary[key].input += row.input_tokens || 0;
        summary[key].output += row.output_tokens || 0;
        summary[key].messages += 1;
      }

      return new Response(JSON.stringify({ summary }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- ADMIN: LIST APPROVED USERS ----
    if (body.mode === "admin_list_users") {
      if (email !== ADMIN_EMAIL) {
        return new Response(JSON.stringify({ error: "admin only" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: users, error: usersErr } = await supabase
        .from("approved_users")
        .select("email, added_at")
        .order("added_at", { ascending: false });
      if (usersErr) {
        return new Response(JSON.stringify({ error: usersErr.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ users }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- ADMIN: ADD APPROVED USER ----
    if (body.mode === "admin_add_user") {
      if (email !== ADMIN_EMAIL) {
        return new Response(JSON.stringify({ error: "admin only" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const newEmail = (body.email || "").trim().toLowerCase();
      if (!newEmail || !newEmail.includes("@")) {
        return new Response(JSON.stringify({ error: "invalid email" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { error: insertErr } = await supabase
        .from("approved_users")
        .insert({ email: newEmail });
      // 23505 = unique violation, i.e. already approved — treat as success, not an error
      if (insertErr && insertErr.code !== "23505") {
        return new Response(JSON.stringify({ error: insertErr.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- ADMIN: REMOVE APPROVED USER ----
    if (body.mode === "admin_remove_user") {
      if (email !== ADMIN_EMAIL) {
        return new Response(JSON.stringify({ error: "admin only" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const targetEmail = (body.email || "").trim().toLowerCase();
      if (!targetEmail) {
        return new Response(JSON.stringify({ error: "invalid email" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (targetEmail === ADMIN_EMAIL) {
        return new Response(JSON.stringify({ error: "can't remove the admin account" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { error: deleteErr } = await supabase
        .from("approved_users")
        .delete()
        .eq("email", targetEmail);
      if (deleteErr) {
        return new Response(JSON.stringify({ error: deleteErr.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
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
    const currentLanguage = body.language === "yo" ? "yo" : "de";
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recent } = await supabase
      .from("mistake_log")
      .select("category")
      .eq("user_email", email)
      .eq("language", currentLanguage)
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

    // Split the stream: one half goes straight to the client (unaffected,
    // still fast), the other half is read in the background just to extract
    // token counts for the admin usage table.
    const [streamToClient, streamToCount] = anthropicRes.body!.tee();

    EdgeRuntime.waitUntil((async () => {
      try {
        const reader = streamToCount.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let inputTokens = 0;
        let outputTokens = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (value) {
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const jsonStr = trimmed.slice(5).trim();
              if (!jsonStr || jsonStr === "[DONE]") continue;
              try {
                const evt = JSON.parse(jsonStr);
                if (evt.type === "message_start" && evt.message?.usage?.input_tokens) {
                  inputTokens = evt.message.usage.input_tokens;
                }
                if (evt.type === "message_delta" && evt.usage?.output_tokens) {
                  outputTokens = evt.usage.output_tokens;
                }
              } catch (_e) { /* ignore unparsable lines */ }
            }
          }
          if (done) break;
        }
        if (inputTokens || outputTokens) {
          await supabase.from("token_usage").insert({
            user_email: email,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          });
        }
      } catch (e) {
        console.error("usage logging failed (non-critical):", e);
      }
    })());

    // Stream Anthropic's response straight through so sentence-by-sentence
    // speech still works on the frontend.
    return new Response(streamToClient, {
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
