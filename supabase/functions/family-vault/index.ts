// Family Vault — Edge Function backend
//
// Gatekeeper for the family document vault. The vault password lives here
// (as the FAMILY_VAULT_PASSWORD secret), never in the browser code. Every
// request must carry the correct password; storage itself is a private
// bucket only this function (via the service role) can touch.

import { createClient } from "jsr:@supabase/supabase-js@2";

const BUCKET = "family-vault";

// The only folders that exist. Anything else in a request is rejected,
// which also blocks path tricks like "../" reaching storage.
const MEMBERS = ["abiodun", "adeola", "jadesola", "motilayo", "family"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: "50MB",
  });
  // "already exists" is the normal case after the first ever request
  if (error && !/already|duplicate/i.test(error.message)) throw error;
  bucketReady = true;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Keep only safe filename characters; preserve the extension.
function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9 ._()-]/g, "_").trim();
  return cleaned.length ? cleaned.slice(0, 120) : "file";
}

// A stored path must be exactly "<member>/<one segment>".
function validPath(path: string): boolean {
  const parts = path.split("/");
  return parts.length === 2 && MEMBERS.includes(parts[0]) &&
    parts[1].length > 0 && !parts[1].includes("..");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const expected = Deno.env.get("FAMILY_VAULT_PASSWORD");
  if (!expected) return json({ error: "Vault password not configured" }, 500);
  if (body.password !== expected) {
    // Small delay so the password can't be guessed rapidly
    await new Promise((r) => setTimeout(r, 1200));
    return json({ error: "Wrong password" }, 401);
  }

  try {
    await ensureBucket();

    switch (body.action) {
      case "login":
        return json({ ok: true });

      // Family photos used by the app's own UI. They live in the private
      // bucket (under _app/) so they are only visible after unlocking.
      case "assets": {
        const [bg, emblem] = await Promise.all([
          supabase.storage.from(BUCKET).createSignedUrl("_app/family-bg.jpg", 3600),
          supabase.storage.from(BUCKET).createSignedUrl("_app/emblem.png", 3600),
        ]);
        return json({
          bg: bg.data?.signedUrl ?? null,
          emblem: emblem.data?.signedUrl ?? null,
        });
      }

      case "list": {
        if (!MEMBERS.includes(body.member)) {
          return json({ error: "Unknown member" }, 400);
        }
        const { data, error } = await supabase.storage.from(BUCKET).list(
          body.member,
          { limit: 1000, sortBy: { column: "created_at", order: "desc" } },
        );
        if (error) throw error;
        const files = (data ?? [])
          .filter((f) => f.id) // folders have no id
          .map((f) => ({
            path: `${body.member}/${f.name}`,
            name: f.name.replace(/^\d{13}-/, ""), // hide the timestamp prefix
            size: f.metadata?.size ?? 0,
            type: f.metadata?.mimetype ?? "",
            created: f.created_at,
          }));
        return json({ files });
      }

      case "upload-url": {
        // "_app" holds the app's own UI photos — fixed names, overwritable
        const isApp = body.member === "_app";
        if (!isApp && !MEMBERS.includes(body.member)) {
          return json({ error: "Unknown member" }, 400);
        }
        const path = isApp
          ? `_app/${sanitizeName(body.filename ?? "file")}`
          : `${body.member}/${Date.now()}-${
            sanitizeName(body.filename ?? "file")
          }`;
        const { data, error } = await supabase.storage.from(BUCKET)
          .createSignedUploadUrl(path, { upsert: true });
        if (error) throw error;
        return json({ path, signedUrl: data.signedUrl });
      }

      case "file-url": {
        if (!validPath(body.path ?? "")) return json({ error: "Bad path" }, 400);
        const { data, error } = await supabase.storage.from(BUCKET)
          .createSignedUrl(body.path, 3600);
        if (error) throw error;
        return json({ url: data.signedUrl });
      }

      case "delete": {
        if (!validPath(body.path ?? "")) return json({ error: "Bad path" }, 400);
        const { error } = await supabase.storage.from(BUCKET)
          .remove([body.path]);
        if (error) throw error;
        return json({ ok: true });
      }

      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (err) {
    return json({ error: String(err?.message ?? err) }, 500);
  }
});
