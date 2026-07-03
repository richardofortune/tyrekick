/**
 * Tyrekick — Cloudflare Worker / Pages Function destination.
 *
 * This is the "owned storage" template. It receives the JSON `FeedbackPayload`
 * that the widget POSTs (with the default `transport: "json"`) and stores each
 * record in Workers KV so you can keep, sort, and export feedback yourself.
 *
 * It exposes two faces:
 *
 *   INGEST (open — reviewers stay frictionless):
 *     POST /            — accept a FeedbackPayload (back-compat root route)
 *     POST /feedback    — same
 *
 *   MANAGEMENT (token-gated — `Authorization: Bearer <TYREKICK_TOKEN>`):
 *     GET   /feedback?status=&route=&since=&limit=  — list, newest first
 *     GET   /feedback/:id                           — single full record
 *     PATCH /feedback/:id                           — resolve / reopen
 *
 * The management surface is the REST API that the tyrekick-mcp
 * MCP server talks to (see /mcp in the repo), so an AI agent can pull the
 * feedback back out and act on it.
 *
 * KV layout:
 *   key       = "fb:<payload.id>"
 *   value     = full stored record JSON (payload + server fields)
 *   metadata  = { t: created_at, s: status, r: route }
 * Listing/filtering reads metadata only; record bodies are fetched just for
 * the page being returned. (KV list caps at 1000 keys per call — fine for
 * prototype scale; D1 is the upgrade path.)
 *
 * It works two ways with the SAME code:
 *   1. As a standalone Worker (cross-origin): the widget on another domain POSTs
 *      here, so we send permissive CORS headers and handle the OPTIONS preflight.
 *   2. As a Cloudflare Pages Function next to your static prototype
 *      (same-origin): CORS is then irrelevant, but the headers are harmless,
 *      so the same file drops in unchanged. See README.md.
 *
 * Bindings: KV namespace `FEEDBACK` + secret `TYREKICK_TOKEN` (see wrangler.toml).
 */

/**
 * The shape the widget sends. Mirrors `src/types.ts` FeedbackPayload.
 * We keep our own copy so this template is self-contained and needs no imports.
 *
 * Schema v2 (2026-07-03) adds `anchor.element` (element identity + visible
 * text), `anchor.context` (nearest heading + landmark), richer `env`, and
 * `page_errors`. The worker stores whatever payload it receives VERBATIM, so
 * the v2 additions are typed loosely below — they flow straight through to KV
 * without inspection. v1 payloads simply lack these fields.
 */
interface FeedbackPayload {
  /** 1 (historical) or 2 (current widget). Anything else is rejected. */
  schema: number;
  id: string;
  created_at: string;
  project_name: string;
  app_version: string;
  route: string;
  url: string;
  body: string;
  reviewer_name: string | null;
  session_id: string;
  anchor: {
    x_pct: number;
    y_pct: number;
    selector: string | null;
    viewport: { w: number; h: number };
    /** v2 only: element identity/text under the click. Stored verbatim. */
    element?: unknown;
    /** v2 only: nearest heading + landmark path. Stored verbatim. */
    context?: unknown;
  };
  /** v1 core fields; v2 adds screen/dpr/dark/touch (stored verbatim). */
  env: { user_agent: string; language: string; [key: string]: unknown };
  /** v2 only: last ≤5 uncaught page errors. Stored verbatim. */
  page_errors?: string[];
}

/** What we actually store: the payload plus server-side lifecycle fields. */
interface FeedbackRecord extends FeedbackPayload {
  /** "open" on ingest; flipped via PATCH /feedback/:id. */
  status: "open" | "resolved";
  /** ISO timestamp of when the Worker received the record. */
  received_at: string;
  /** ISO timestamp set when resolved, null while open. */
  resolved_at: string | null;
  /** Optional note supplied when resolving, null otherwise. */
  resolution_note: string | null;
}

/**
 * The compact KV metadata stored next to each key. Kept single-letter so the
 * list endpoint can filter/sort thousands of entries without fetching bodies.
 */
interface FeedbackMeta {
  /** created_at of the record (ISO — sorts lexicographically = chronologically). */
  t: string;
  /** status: "open" | "resolved". */
  s: string;
  /** route the comment was left on. */
  r: string;
}

/*
 * Minimal Workers KV type declarations — just the surface this file uses —
 * so the template stays dependency-free (no @cloudflare/workers-types import).
 */
interface KVListKey<M> {
  name: string;
  metadata?: M;
}
interface KVListResult<M> {
  keys: KVListKey<M>[];
  list_complete: boolean;
  cursor?: string;
}
interface KVNamespace {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string, options?: { metadata?: unknown }): Promise<void>;
  list<M>(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<KVListResult<M>>;
}

/** Environment bindings declared in wrangler.toml (+ the wrangler secret). */
interface Env {
  /** Workers KV namespace that stores one entry per submitted comment. */
  FEEDBACK: KVNamespace;
  /**
   * Shared secret for the management routes, set via
   * `wrangler secret put TYREKICK_TOKEN`. If unset, management routes refuse
   * every request (they are never open by default). Ingest ignores it.
   */
  TYREKICK_TOKEN?: string;
}

/** Longest comment body we keep. Anything over this is truncated with an ellipsis. */
const MAX_BODY = 2000;

/** List page size: default when `limit` is absent/garbage, and the hard cap. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** KV key prefix for feedback records. */
const KEY_PREFIX = "fb:";

/**
 * Permissive CORS headers so a cross-origin prototype can both POST here AND
 * read the JSON response body. For a same-origin Pages Function these are
 * simply ignored by the browser. The management routes are server-to-server
 * (curl / MCP), where CORS never applies — sending the headers is harmless.
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

/** Small helper: JSON response with CORS headers applied. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

/**
 * Gate for the management routes. Returns null when the caller presented the
 * correct bearer token, otherwise a ready-to-send 401 response.
 *
 * Security posture: if TYREKICK_TOKEN was never configured, we still return
 * 401 (with a hint) rather than letting the read/write surface fall open.
 */
function requireAuth(request: Request, env: Env): Response | null {
  if (!env.TYREKICK_TOKEN) {
    return json({ ok: false, error: "TYREKICK_TOKEN not configured" }, 401);
  }
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (token !== env.TYREKICK_TOKEN) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  return null;
}

/** Read + parse one stored record. Returns null if missing or corrupt. */
async function loadRecord(env: Env, id: string): Promise<FeedbackRecord | null> {
  const raw = await env.FEEDBACK.get(KEY_PREFIX + id, "text");
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as FeedbackRecord;
  } catch {
    return null; // A corrupt value is treated the same as a missing one.
  }
}

/** Write a record and keep its KV metadata in sync with the record fields. */
async function saveRecord(env: Env, record: FeedbackRecord): Promise<void> {
  const metadata: FeedbackMeta = {
    t: record.created_at || record.received_at,
    s: record.status,
    r: record.route ?? "",
  };
  await env.FEEDBACK.put(KEY_PREFIX + record.id, JSON.stringify(record), { metadata });
}

/* ------------------------------------------------------------------------ */
/* Route handlers                                                            */
/* ------------------------------------------------------------------------ */

/** POST / and POST /feedback — open ingest of a widget FeedbackPayload. */
async function handleIngest(request: Request, env: Env): Promise<Response> {
  // Parse the JSON body defensively — malformed JSON must not throw.
  let payload: FeedbackPayload;
  try {
    payload = (await request.json()) as FeedbackPayload;
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  // Accept schema v1 (historical) and v2 (current widget). Reject anything
  // we don't understand or that carries no comment text.
  if (payload?.schema !== 1 && payload?.schema !== 2) {
    return json({ ok: false, error: "unsupported_schema" }, 400);
  }
  const trimmed = typeof payload.body === "string" ? payload.body.trim() : "";
  if (!trimmed) {
    return json({ ok: false, error: "empty_body" }, 400);
  }

  // Truncate over-long bodies so one giant comment can't bloat a KV value.
  payload.body = trimmed.length > MAX_BODY ? trimmed.slice(0, MAX_BODY) + "…" : trimmed;

  // Normalise the id/timestamp so the key is always valid, then wrap the
  // payload in the stored record shape (payload + server lifecycle fields).
  const receivedAt = new Date().toISOString();
  payload.id = payload.id || crypto.randomUUID();
  payload.created_at = payload.created_at || receivedAt;

  const record: FeedbackRecord = {
    ...payload,
    status: "open",
    received_at: receivedAt,
    resolved_at: null,
    resolution_note: null,
  };

  // Store under "fb:<id>" with filter metadata. Any write failure surfaces as
  // ok:false so the widget can offer "Copy your comment?" instead of losing it.
  try {
    await saveRecord(env, record);
  } catch {
    return json({ ok: false, error: "storage_failed" }, 500);
  }

  // Success. HTTP 2xx + a body that is not {"ok":false} = the widget's
  // definition of a successful "json" submission.
  return json({ ok: true, id: record.id });
}

/** GET /feedback — token-gated list, newest first, filtered via KV metadata. */
async function handleList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const route = url.searchParams.get("route");
  const since = url.searchParams.get("since");

  if (status !== null && status !== "open" && status !== "resolved") {
    return json({ ok: false, error: "invalid_status" }, 400);
  }

  // limit: default 50, clamped to [1, 200]; garbage falls back to the default.
  let limit = DEFAULT_LIMIT;
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    limit = Number.isFinite(n) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(n))) : DEFAULT_LIMIT;
  }

  // Walk the full "fb:" keyspace reading METADATA ONLY. Each list() call
  // returns up to 1000 keys; follow the cursor until complete.
  const keys: KVListKey<FeedbackMeta>[] = [];
  try {
    let cursor: string | undefined;
    do {
      const page = await env.FEEDBACK.list<FeedbackMeta>({ prefix: KEY_PREFIX, cursor });
      keys.push(...page.keys);
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } catch {
    return json({ ok: false, error: "storage_failed" }, 500);
  }

  // Filter on metadata alone. Keys written without metadata (shouldn't happen
  // with this Worker) get permissive defaults rather than crashing the list.
  const filtered = keys.filter((k) => {
    const m = k.metadata;
    if (status && (m?.s ?? "open") !== status) return false;
    if (route && (m?.r ?? "") !== route) return false;
    // ISO-8601 strings compare lexicographically in chronological order.
    if (since && (m?.t ?? "") < since) return false;
    return true;
  });

  // Newest first, then take one page.
  filtered.sort((a, b) => (b.metadata?.t ?? "").localeCompare(a.metadata?.t ?? ""));
  const pageKeys = filtered.slice(0, limit);

  // Only NOW fetch the record bodies — one get per returned row, in parallel.
  let bodies: (string | null)[];
  try {
    bodies = await Promise.all(pageKeys.map((k) => env.FEEDBACK.get(k.name, "text")));
  } catch {
    return json({ ok: false, error: "storage_failed" }, 500);
  }

  const items: FeedbackRecord[] = [];
  for (const raw of bodies) {
    if (raw === null) continue; // deleted between list() and get() — skip
    try {
      items.push(JSON.parse(raw) as FeedbackRecord);
    } catch {
      // Corrupt value: skip rather than failing the whole page.
    }
  }

  return json({ ok: true, count: items.length, total: filtered.length, items });
}

/** GET /feedback/:id — token-gated single full record. */
async function handleGetOne(env: Env, id: string): Promise<Response> {
  let record: FeedbackRecord | null;
  try {
    record = await loadRecord(env, id);
  } catch {
    return json({ ok: false, error: "storage_failed" }, 500);
  }
  if (record === null) {
    return json({ ok: false, error: "not found" }, 404);
  }
  return json({ ok: true, item: record });
}

/** PATCH /feedback/:id — token-gated resolve/reopen. Returns the updated record. */
async function handlePatch(request: Request, env: Env, id: string): Promise<Response> {
  // Parse the PATCH body defensively.
  let body: { status?: unknown; note?: unknown };
  try {
    body = (await request.json()) as { status?: unknown; note?: unknown };
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const nextStatus = body?.status;
  if (nextStatus !== "resolved" && nextStatus !== "open") {
    return json({ ok: false, error: "invalid_status" }, 400);
  }
  const note = typeof body?.note === "string" ? body.note : null;

  let record: FeedbackRecord | null;
  try {
    record = await loadRecord(env, id);
  } catch {
    return json({ ok: false, error: "storage_failed" }, 500);
  }
  if (record === null) {
    return json({ ok: false, error: "not found" }, 404);
  }

  // Apply the transition. Reopening clears the resolution fields.
  record.status = nextStatus;
  if (nextStatus === "resolved") {
    record.resolved_at = new Date().toISOString();
    record.resolution_note = note;
  } else {
    record.resolved_at = null;
    record.resolution_note = null;
  }

  // Persist record + refreshed metadata (so list filters see the new status).
  try {
    await saveRecord(env, record);
  } catch {
    return json({ ok: false, error: "storage_failed" }, 500);
  }

  return json({ ok: true, item: record });
}

/* ------------------------------------------------------------------------ */
/* Router                                                                    */
/* ------------------------------------------------------------------------ */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight. Browsers send OPTIONS before a cross-origin POST that
    // carries a Content-Type: application/json header. Answer it with 204.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Normalise the path: strip trailing slashes ("/feedback/" == "/feedback").
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // The /feedback routes are matched on the TRAILING segment so the same
    // file works standalone (".../feedback") AND as a Pages Function mounted
    // at a nested route (".../api/feedback"). The "/feedback" needle carries
    // its leading slash, so "/xfeedback" can never match.
    const itemMarker = path.lastIndexOf("/feedback/");

    // POST / (back-compat) — open ingest.
    if (path === "/") {
      if (request.method === "POST") return handleIngest(request, env);
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }

    // /feedback (collection) — POST ingest (open) or GET list (token-gated).
    if (path.endsWith("/feedback")) {
      if (request.method === "POST") return handleIngest(request, env);
      if (request.method === "GET") {
        return requireAuth(request, env) ?? handleList(request, env);
      }
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }

    // /feedback/:id — GET one or PATCH (both token-gated).
    if (itemMarker !== -1) {
      const rawId = path.slice(itemMarker + "/feedback/".length);
      if (!rawId || rawId.includes("/")) {
        return json({ ok: false, error: "not found" }, 404);
      }
      // The widget's ids are UUIDs, but decode defensively for anything else.
      let id: string;
      try {
        id = decodeURIComponent(rawId);
      } catch {
        return json({ ok: false, error: "not found" }, 404);
      }
      if (request.method === "GET") {
        return requireAuth(request, env) ?? handleGetOne(env, id);
      }
      if (request.method === "PATCH") {
        return requireAuth(request, env) ?? handlePatch(request, env, id);
      }
      return json({ ok: false, error: "method_not_allowed" }, 405);
    }

    // Anything else is off the map.
    return json({ ok: false, error: "not_found" }, 404);
  },
};
