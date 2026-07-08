// Deploy path: supabase/functions/outreach-cron/index.ts
// Deploy with:  supabase functions deploy outreach-cron --no-verify-jwt
//   (--no-verify-jwt because pg_cron calls this with a shared secret, not a
//    user session. We do our own secret check below.)
//
// Secrets it needs:
//   supabase secrets set CRON_SECRET=<a long random string>
//   supabase secrets set RESEND_API_KEY=<your Resend API key>
//
// What it does, each time pg_cron pokes it (see outreach-setup.sql for the
// schedule): find every 'approved' outreach row whose send_after has passed,
// and — respecting unsubscribes, the per-user daily cap, and each user's
// sender identity — send it via Resend with a compliant footer.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";

// The public base for the unsubscribe link (this project's functions host).
const FUNCTIONS_BASE = SUPABASE_URL.replace(".supabase.co", ".functions.supabase.co");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const esc = (s: string) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Turn a plain-text body into simple HTML, then append signature + the
// legally-required footer (sender's physical address + unsubscribe link).
function buildHtml(body: string, settings: any, prospectEmail: string): string {
  const bodyHtml = esc(body).replace(/\n/g, "<br>");
  const unsubToken = btoa(prospectEmail).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unsubUrl = `${FUNCTIONS_BASE}/prospector?u=${unsubToken}`;
  const sig = settings.signature ? `${esc(settings.signature).replace(/\n/g, "<br>")}<br><br>` : "";
  const addr = settings.physical_address ? `${esc(settings.physical_address)}<br>` : "";
  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#1a1a1a;line-height:1.55">
      ${bodyHtml}
      <br><br>${sig}
      <hr style="border:none;border-top:1px solid #e5e5e5;margin:20px 0 10px">
      <div style="font-size:12px;color:#999">
        ${addr}
        You received this because we thought it was relevant to your work.
        <a href="${unsubUrl}" style="color:#999">Unsubscribe</a>.
      </div>
    </div>`;
}

Deno.serve(async (req) => {
  // ---- auth: shared secret, not a user session ----
  const secret = req.headers.get("x-cron-secret") || "";
  if (!CRON_SECRET || secret !== CRON_SECRET) return json({ error: "forbidden" }, 403);
  if (!RESEND_API_KEY) return json({ error: "RESEND_API_KEY not set" }, 500);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const nowIso = new Date().toISOString();

  // Pull a batch of what's due. Small batch keeps each run well under the
  // function time limit and spreads sends out naturally.
  const { data: due, error: dueErr } = await supabase
    .from("outreach")
    .select("*")
    .eq("status", "approved")
    .lte("send_after", nowIso)
    .order("send_after", { ascending: true })
    .limit(50);

  if (dueErr) return json({ error: dueErr.message }, 500);
  if (!due || !due.length) return json({ ok: true, sent: 0, skipped: 0, failed: 0 });

  // Small per-run caches so we don't re-query settings/caps for every row.
  const settingsCache: Record<string, any> = {};
  const sentTodayCache: Record<string, number> = {};
  const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);

  async function getSettings(user: string) {
    if (settingsCache[user] !== undefined) return settingsCache[user];
    const { data } = await supabase.from("sender_settings").select("*").eq("user_email", user).maybeSingle();
    settingsCache[user] = data || null;
    return settingsCache[user];
  }
  async function getSentToday(user: string): Promise<number> {
    if (sentTodayCache[user] !== undefined) return sentTodayCache[user];
    const { count } = await supabase
      .from("outreach").select("id", { count: "exact", head: true })
      .eq("user_email", user).eq("status", "sent").gte("sent_at", startOfDay.toISOString());
    sentTodayCache[user] = count || 0;
    return sentTodayCache[user];
  }

  let sent = 0, skipped = 0, failed = 0;

  for (const row of due) {
    // 1) Honour unsubscribes.
    const { data: unsub } = await supabase
      .from("unsubscribes").select("email").eq("email", row.prospect_email).maybeSingle();
    if (unsub) {
      await supabase.from("outreach").update({ status: "unsubscribed" }).eq("id", row.id);
      skipped++; continue;
    }

    // 2) Sender must have a from_email on a verified domain.
    const settings = await getSettings(row.user_email);
    if (!settings || !settings.from_email) {
      await supabase.from("outreach").update({
        status: "failed", error: "no sender from_email configured",
      }).eq("id", row.id);
      failed++; continue;
    }

    // 3) Respect the daily cap — leave the row approved for a later run.
    const cap = settings.daily_cap ?? 50;
    if (await getSentToday(row.user_email) >= cap) { skipped++; continue; }

    // 4) Send via Resend.
    try {
      const fromHeader = settings.from_name
        ? `${settings.from_name} <${settings.from_email}>`
        : settings.from_email;
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: fromHeader,
          to: [row.prospect_email],
          reply_to: settings.reply_to || settings.from_email,
          subject: row.subject,
          html: buildHtml(row.body, settings, row.prospect_email),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        await supabase.from("outreach").update({
          status: "failed", error: (data?.message || `HTTP ${res.status}`).slice(0, 300),
        }).eq("id", row.id);
        failed++; continue;
      }
      await supabase.from("outreach").update({
        status: "sent", sent_at: new Date().toISOString(), resend_id: data.id || null, error: null,
      }).eq("id", row.id);
      sentTodayCache[row.user_email] = (sentTodayCache[row.user_email] || 0) + 1;
      sent++;
    } catch (e) {
      await supabase.from("outreach").update({ status: "failed", error: String(e).slice(0, 300) }).eq("id", row.id);
      failed++;
    }
  }

  return json({ ok: true, sent, skipped, failed });
});
