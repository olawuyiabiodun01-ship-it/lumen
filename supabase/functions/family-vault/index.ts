// Family Vault — Edge Function backend
//
// Gatekeeper for the family document vault. The vault password lives here
// (as the FAMILY_VAULT_PASSWORD secret), never in the browser code. Every
// request must carry the correct password; storage itself is a private
// bucket only this function (via the service role) can touch.
//
// Documents are organised like a library: each member has a set of fixed
// shelves (certificates, id-cards, ...). One shelf, "confidential", needs a
// SECOND secret (FAMILY_VAULT_PRIVATE_CODE) before it will open at all.

import { createClient } from "jsr:@supabase/supabase-js@2";

const BUCKET = "family-vault";

// The only member folders that exist. Anything else is rejected, which also
// blocks path tricks like "../" reaching storage.
const MEMBERS = ["abiodun", "adeola", "jadesola", "motilayo", "family"];

// The only shelves that exist inside each member folder.
const SHELVES = [
  "certificates",
  "id-cards",
  "permits",
  "admission",
  "job-career",
  "other",
  "confidential",
];

// This shelf is gated by the extra secret code.
const LOCKED_SHELF = "confidential";

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

// A stored document path must be exactly "<member>/<shelf>/<file>".
function validPath(path: string): boolean {
  const parts = path.split("/");
  return parts.length === 3 && MEMBERS.includes(parts[0]) &&
    SHELVES.includes(parts[1]) && parts[2].length > 0 && !path.includes("..");
}

// Returns an error Response if the shelf is locked and the code is wrong,
// otherwise null (access allowed).
function guardLocked(shelf: string, code: string | undefined): Response | null {
  if (shelf !== LOCKED_SHELF) return null;
  const secret = Deno.env.get("FAMILY_VAULT_PRIVATE_CODE");
  if (!secret) return json({ error: "Secret code not configured" }, 500);
  if (code !== secret) return json({ error: "code", locked: true }, 403);
  return null;
}

async function countShelf(member: string, shelf: string): Promise<number> {
  const { data } = await supabase.storage.from(BUCKET).list(
    `${member}/${shelf}`,
    { limit: 1000 },
  );
  return (data ?? []).filter((f) => f.id).length;
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
    await new Promise((r) => setTimeout(r, 1200)); // slow down guessing
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

      // Verify the confidential secret code without opening anything.
      case "check-code": {
        const blocked = guardLocked(LOCKED_SHELF, body.code);
        return blocked ?? json({ ok: true });
      }

      // How many documents sit on each shelf, for the library overview.
      case "overview": {
        if (!MEMBERS.includes(body.member)) {
          return json({ error: "Unknown member" }, 400);
        }
        const counts: Record<string, number> = {};
        await Promise.all(
          SHELVES.map(async (s) => (counts[s] = await countShelf(body.member, s))),
        );
        return json({ counts });
      }

      case "list": {
        if (!MEMBERS.includes(body.member)) {
          return json({ error: "Unknown member" }, 400);
        }
        if (!SHELVES.includes(body.shelf)) {
          return json({ error: "Unknown shelf" }, 400);
        }
        const blocked = guardLocked(body.shelf, body.code);
        if (blocked) return blocked;

        const prefix = `${body.member}/${body.shelf}`;
        const { data, error } = await supabase.storage.from(BUCKET).list(
          prefix,
          { limit: 1000, sortBy: { column: "created_at", order: "desc" } },
        );
        if (error) throw error;
        const files = (data ?? [])
          .filter((f) => f.id) // folders have no id
          .map((f) => ({
            path: `${prefix}/${f.name}`,
            name: f.name.replace(/^\d{13}-/, ""), // hide the timestamp prefix
            size: f.metadata?.size ?? 0,
            type: f.metadata?.mimetype ?? "",
            created: f.created_at,
          }));
        return json({ files });
      }

      case "upload-url": {
        // "_app" holds the app's own UI photos — fixed names, overwritable
        if (body.member === "_app") {
          const path = `_app/${sanitizeName(body.filename ?? "file")}`;
          const { data, error } = await supabase.storage.from(BUCKET)
            .createSignedUploadUrl(path, { upsert: true });
          if (error) throw error;
          return json({ path, signedUrl: data.signedUrl });
        }
        if (!MEMBERS.includes(body.member)) {
          return json({ error: "Unknown member" }, 400);
        }
        if (!SHELVES.includes(body.shelf)) {
          return json({ error: "Unknown shelf" }, 400);
        }
        const blocked = guardLocked(body.shelf, body.code);
        if (blocked) return blocked;

        const path = `${body.member}/${body.shelf}/${Date.now()}-${
          sanitizeName(body.filename ?? "file")
        }`;
        const { data, error } = await supabase.storage.from(BUCKET)
          .createSignedUploadUrl(path);
        if (error) throw error;
        return json({ path, signedUrl: data.signedUrl });
      }

      case "file-url": {
        if (!validPath(body.path ?? "")) return json({ error: "Bad path" }, 400);
        const blocked = guardLocked(body.path.split("/")[1], body.code);
        if (blocked) return blocked;
        const { data, error } = await supabase.storage.from(BUCKET)
          .createSignedUrl(body.path, 3600);
        if (error) throw error;
        return json({ url: data.signedUrl });
      }

      case "delete": {
        if (!validPath(body.path ?? "")) return json({ error: "Bad path" }, 400);
        const blocked = guardLocked(body.path.split("/")[1], body.code);
        if (blocked) return blocked;
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
