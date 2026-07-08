// Family Vault — Edge Function backend
//
// Gatekeeper for the family document vault. The vault password lives here
// (as the FAMILY_VAULT_PASSWORD secret), never in the browser code. Every
// request must carry the correct password; storage itself is a private
// bucket only this function (via the service role) can touch.
//
// Documents are organised like a library: each member has a set of fixed
// shelves (certificates, id-cards, ...). One shelf, "confidential", needs a
// SECOND secret — a per-member 4-digit code (FAMILY_VAULT_CODE_<MEMBER>) —
// before it will open at all.

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

// This shelf is gated by the per-member secret code.
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

// Each member has their own confidential code, held as its own secret.
function memberCode(member: string): string | undefined {
  return Deno.env.get(`FAMILY_VAULT_CODE_${member.toUpperCase()}`);
}

// Returns an error Response if the shelf is locked and the code is wrong for
// this member, otherwise null (access allowed). Slows down wrong guesses.
async function guardLocked(
  member: string,
  shelf: string,
  code: string | undefined,
): Promise<Response | null> {
  if (shelf !== LOCKED_SHELF) return null;
  const secret = memberCode(member);
  if (!secret) return json({ error: "Secret code not configured", locked: true }, 500);
  if (code !== secret) {
    await sleep(1000); // brake on 4-digit guessing (also behind the main password)
    return json({ error: "code", locked: true }, 403);
  }
  return null;
}

// List a single shelf, already filtered to real files (folders have no id).
async function listShelf(member: string, shelf: string) {
  const { data } = await supabase.storage.from(BUCKET).list(
    `${member}/${shelf}`,
    { limit: 1000, sortBy: { column: "created_at", order: "desc" } },
  );
  return (data ?? []).filter((f) => f.id).map((f) => ({
    path: `${member}/${shelf}/${f.name}`,
    name: f.name.replace(/^\d{13}-/, ""), // hide the timestamp prefix
    shelf,
    size: f.metadata?.size ?? 0,
    type: f.metadata?.mimetype ?? "",
    created: f.created_at,
  }));
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
    await sleep(1200); // slow down password guessing
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

      // Verify a member's confidential code without opening anything.
      case "check-code": {
        if (!MEMBERS.includes(body.member)) {
          return json({ error: "Unknown member" }, 400);
        }
        const blocked = await guardLocked(body.member, LOCKED_SHELF, body.code);
        return blocked ?? json({ ok: true });
      }

      // Everything in one member's library: per-shelf counts (for the grid)
      // plus every document (for search). Confidential files are only
      // included when the member's code is supplied and correct — but its
      // count is always returned (a count reveals nothing).
      case "library": {
        if (!MEMBERS.includes(body.member)) {
          return json({ error: "Unknown member" }, 400);
        }
        const unlocked = !!memberCode(body.member) &&
          body.code === memberCode(body.member);
        const counts: Record<string, number> = {};
        const files: unknown[] = [];
        await Promise.all(SHELVES.map(async (shelf) => {
          const items = await listShelf(body.member, shelf);
          counts[shelf] = items.length;
          if (shelf === LOCKED_SHELF && !unlocked) return; // hide the docs
          files.push(...items);
        }));
        files.sort((a: any, b: any) =>
          (b.created ?? "").localeCompare(a.created ?? ""));
        return json({ counts, files, confidentialLocked: !unlocked });
      }

      case "list": {
        if (!MEMBERS.includes(body.member)) {
          return json({ error: "Unknown member" }, 400);
        }
        if (!SHELVES.includes(body.shelf)) {
          return json({ error: "Unknown shelf" }, 400);
        }
        const blocked = await guardLocked(body.member, body.shelf, body.code);
        if (blocked) return blocked;
        return json({ files: await listShelf(body.member, body.shelf) });
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
        const blocked = await guardLocked(body.member, body.shelf, body.code);
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
        const [member, shelf] = body.path.split("/");
        const blocked = await guardLocked(member, shelf, body.code);
        if (blocked) return blocked;
        const { data, error } = await supabase.storage.from(BUCKET)
          .createSignedUrl(body.path, 3600);
        if (error) throw error;
        return json({ url: data.signedUrl });
      }

      case "delete": {
        if (!validPath(body.path ?? "")) return json({ error: "Bad path" }, 400);
        const [member, shelf] = body.path.split("/");
        const blocked = await guardLocked(member, shelf, body.code);
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
