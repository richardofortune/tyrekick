/**
 * Review window (worker side): TYREKICK_OPEN_UNTIL gates INGEST ONLY.
 *
 * The load-bearing test in this file is the first one: a worker with no
 * TYREKICK_OPEN_UNTIL var must accept ingest byte-for-byte as it did before the
 * var existed. Every already-deployed worker is in exactly that state, so a
 * regression here silently breaks all of them.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import worker from "../../destinations/cloudflare/worker";

/** In-memory FEEDBACK KV stand-in that also records every put (mirrors worker-shared.test.ts). */
function fakeKV(records: Record<string, unknown>[] = []) {
  const store = new Map<string, { value: string; metadata: unknown }>();
  const puts: string[] = [];
  for (const r of records) {
    const rec = r as { id: string; created_at: string; status: string; route: string; project_name: string };
    store.set("fb:" + rec.id, {
      value: JSON.stringify(r),
      metadata: { t: rec.created_at, s: rec.status, r: rec.route, p: rec.project_name },
    });
  }
  return {
    puts,
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async put(key: string, value: string, opts?: { metadata?: unknown }) {
      puts.push(key);
      store.set(key, { value, metadata: opts?.metadata });
    },
    async list<M>() {
      return {
        keys: [...store.entries()].map(([name, v]) => ({ name, metadata: v.metadata as M })),
        list_complete: true,
      };
    },
  };
}

const FIXED_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** A stored record as the worker would have written it on ingest. */
function record(over: Record<string, unknown> = {}) {
  return {
    schema: 2,
    id: FIXED_ID,
    created_at: "2026-07-20T09:00:00.000Z",
    project_name: "demo-project",
    app_version: "1.0.0",
    route: "/pricing",
    url: "https://example.test/pricing",
    body: "the price here is confusing",
    reviewer_name: "Dana",
    anchor: {
      x_pct: 20,
      y_pct: 15,
      selector: "#cta",
      viewport: { w: 800, h: 600 },
      element: null,
      context: { heading: null, landmark: null },
    },
    env: { user_agent: "UA", language: "en-NZ", dark: false },
    page_errors: [],
    status: "open",
    received_at: "2026-07-20T09:00:01.000Z",
    resolved_at: null,
    resolution_note: null,
    ai_reply: null,
    ...over,
  };
}

function post(url: string, id = FIXED_ID) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema: 2,
      id,
      project_name: "demo-project",
      app_version: "1.0.0",
      route: "/pricing",
      url: "https://example.test/pricing",
      body: "the price here is confusing",
      anchor: { x_pct: 20, y_pct: 15, selector: "#cta", viewport: { w: 800, h: 600 } },
    }),
  });
}

function get(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { method: "GET", headers });
}

/** A ctx that records whether anything was ever scheduled after the response. */
function countingCtx() {
  const tasks: Promise<unknown>[] = [];
  return { tasks, ctx: { waitUntil: (p: Promise<unknown>) => void tasks.push(p) } };
}

const PAST = "2026-08-28T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

afterEach(() => {
  vi.useRealTimers();
});

describe("review window — ingest gate", () => {
  // THE regression test. Every worker deployed before this feature existed has
  // no TYREKICK_OPEN_UNTIL, and must keep accepting comments forever.
  it("with NO window var configured, ingest works exactly as before", async () => {
    const kv = fakeKV();
    const { ctx } = countingCtx();
    const res = await worker.fetch(post("https://w.test/feedback"), { FEEDBACK: kv } as never, ctx as never);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body).toEqual({ ok: true, id: FIXED_ID });
    expect(kv.puts).toEqual(["fb:" + FIXED_ID]);

    // The stored record is the same shape the rest of the suite relies on.
    const stored = JSON.parse((await kv.get("fb:" + FIXED_ID))!);
    expect(stored.status).toBe("open");
    expect(stored.resolved_at).toBeNull();
    expect(stored.resolution_note).toBeNull();
    expect(stored.ai_reply).toBeNull();
    expect(typeof stored.received_at).toBe("string");
    expect(stored.body).toBe("the price here is confusing");
  });

  // A typo in the var can fail to CLOSE a review; it must never silently shut
  // a live one. This is the single point of failure for back-compat.
  it.each(["", "   ", "not-a-date", "next friday", "2026-9-15"])(
    "fails OPEN for an unusable window value (%j)",
    async (raw) => {
      const kv = fakeKV();
      const { ctx } = countingCtx();
      const res = await worker.fetch(
        post("https://w.test/feedback"),
        { FEEDBACK: kv, TYREKICK_OPEN_UNTIL: raw } as never,
        ctx as never,
      );
      expect(res.status).toBe(200);
      expect(kv.puts).toHaveLength(1);
    },
  );

  it("a future instant leaves the review open", async () => {
    const kv = fakeKV();
    const { ctx } = countingCtx();
    const res = await worker.fetch(
      post("https://w.test/feedback"),
      { FEEDBACK: kv, TYREKICK_OPEN_UNTIL: FUTURE } as never,
      ctx as never,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: FIXED_ID });
    expect(kv.puts).toEqual(["fb:" + FIXED_ID]);
  });

  it("a past instant refuses POST /feedback with 403 review_closed, stores nothing, tees nothing", async () => {
    const kv = fakeKV();
    const { ctx, tasks } = countingCtx();
    const res = await worker.fetch(
      post("https://w.test/feedback"),
      { FEEDBACK: kv, TYREKICK_OPEN_UNTIL: PAST, DISCORD_WEBHOOK: "https://discord.test/x", ANTHROPIC_API_KEY: "k" } as never,
      ctx as never,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "review_closed", open_until: PAST });
    expect(kv.puts).toEqual([]);
    expect(tasks).toEqual([]);
  });

  // The widget reads this body cross-origin; without CORS it cannot tell a
  // closed review from a network failure.
  it("the 403 carries CORS headers", async () => {
    const res = await worker.fetch(
      post("https://w.test/feedback"),
      { FEEDBACK: fakeKV(), TYREKICK_OPEN_UNTIL: PAST } as never,
      countingCtx().ctx as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  // Proves the guard lives in handleIngest, not in the router.
  it("the back-compat POST / route gets the same 403", async () => {
    const kv = fakeKV();
    const res = await worker.fetch(
      post("https://w.test/"),
      { FEEDBACK: kv, TYREKICK_OPEN_UNTIL: PAST } as never,
      countingCtx().ctx as never,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "review_closed", open_until: PAST });
    expect(kv.puts).toEqual([]);
  });

  it("the boundary is inclusive — an instant equal to now is closed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PAST));
    const res = await worker.fetch(
      post("https://w.test/feedback"),
      { FEEDBACK: fakeKV(), TYREKICK_OPEN_UNTIL: PAST } as never,
      countingCtx().ctx as never,
    );
    expect(res.status).toBe(403);
  });

  it("one millisecond before the instant, ingest is still open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(PAST) - 1));
    const res = await worker.fetch(
      post("https://w.test/feedback"),
      { FEEDBACK: fakeKV(), TYREKICK_OPEN_UNTIL: PAST } as never,
      countingCtx().ctx as never,
    );
    expect(res.status).toBe(200);
  });
});

// Constraint 3: closing gates ingest ONLY. This is the test that catches
// someone "helpfully" hoisting the guard up into the router.
describe("review window — every read route still works while closed", () => {
  const env = () =>
    ({
      FEEDBACK: fakeKV([record()]),
      TYREKICK_OPEN_UNTIL: PAST,
      TYREKICK_TOKEN: "t0ken",
      TYREKICK_REVIEW_KEY: "rk-secret",
    }) as never;
  const AUTH = { Authorization: "Bearer t0ken" };

  it("GET /feedback still lists (token)", async () => {
    const res = await worker.fetch(get("https://w.test/feedback", AUTH), env(), countingCtx().ctx as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; items: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.items).toHaveLength(1);
  });

  it("GET /feedback/:id still reads one record (token)", async () => {
    const res = await worker.fetch(
      get(`https://w.test/feedback/${FIXED_ID}`, AUTH),
      env(),
      countingCtx().ctx as never,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { item: { id: string } }).item.id).toBe(FIXED_ID);
  });

  it("PATCH /feedback/:id still resolves (token)", async () => {
    const res = await worker.fetch(
      new Request(`https://w.test/feedback/${FIXED_ID}`, {
        method: "PATCH",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "resolved", note: "fixed in the next wave" }),
      }),
      env(),
      countingCtx().ctx as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; item: { status: string; resolution_note: string } };
    expect(body.ok).toBe(true);
    expect(body.item.status).toBe("resolved");
    expect(body.item.resolution_note).toBe("fixed in the next wave");
  });

  it("GET /receipts still returns the reviewer's own pin", async () => {
    const res = await worker.fetch(
      get(`https://w.test/receipts?ids=${FIXED_ID}`),
      env(),
      countingCtx().ctx as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { receipts: Array<{ id: string }> };
    expect(body.receipts).toHaveLength(1);
    expect(body.receipts[0].id).toBe(FIXED_ID);
  });

  it("GET /shared still renders the project view (review key)", async () => {
    const res = await worker.fetch(
      get("https://w.test/shared?project=demo-project", { "X-Tyrekick-Review-Key": "rk-secret" }),
      env(),
      countingCtx().ctx as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; pins: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.pins).toHaveLength(1);
  });
});

describe("review window — /receipts discovery envelope", () => {
  const probe = (over: Record<string, unknown>) =>
    worker.fetch(get("https://w.test/receipts?ids="), { FEEDBACK: fakeKV(), ...over } as never, countingCtx().ctx as never);

  it("no var → open with no instant", async () => {
    expect(await (await probe({})).json()).toEqual({
      ok: true,
      receipts: [],
      review: { state: "open", open_until: null },
    });
  });

  it("future instant → open, and the instant is echoed so the CLI can print it", async () => {
    expect(await (await probe({ TYREKICK_OPEN_UNTIL: FUTURE })).json()).toEqual({
      ok: true,
      receipts: [],
      review: { state: "open", open_until: FUTURE },
    });
  });

  it("past instant → closed", async () => {
    expect(await (await probe({ TYREKICK_OPEN_UNTIL: PAST })).json()).toEqual({
      ok: true,
      receipts: [],
      review: { state: "closed", open_until: PAST },
    });
  });

  it("the populated branch carries review too, and the per-receipt projection is unchanged", async () => {
    const res = await worker.fetch(
      get(`https://w.test/receipts?ids=${FIXED_ID}`),
      { FEEDBACK: fakeKV([record({ status: "resolved", resolved_at: "2026-08-01T00:00:00.000Z", resolution_note: "done", ai_reply: "thanks!" })]), TYREKICK_OPEN_UNTIL: PAST } as never,
      countingCtx().ctx as never,
    );
    expect(await res.json()).toEqual({
      ok: true,
      receipts: [
        {
          id: FIXED_ID,
          status: "resolved",
          resolved_at: "2026-08-01T00:00:00.000Z",
          resolution_note: "done",
          ai_reply: "thanks!",
        },
      ],
      review: { state: "closed", open_until: PAST },
    });
  });

  // GET / advertises route NAMES only. A guard against adding `review` here
  // "for symmetry" — it would make the root a configuration oracle.
  it("GET / is unchanged and carries no review key", async () => {
    const res = await worker.fetch(
      get("https://w.test/"),
      { FEEDBACK: fakeKV(), TYREKICK_OPEN_UNTIL: PAST } as never,
      countingCtx().ctx as never,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["ok", "service", "routes"]);
    expect(body.service).toBe("tyrekick");
  });
});
