import { describe, it, expect } from "vitest";
import worker from "../../destinations/cloudflare/worker";

/**
 * Minimal in-memory stand-in for the FEEDBACK KV namespace: enough surface for
 * the handlers (get/put/list with metadata), nothing more.
 */
function fakeKV(records: Record<string, unknown>[] = []) {
  const store = new Map<string, { value: string; metadata: unknown }>();
  for (const r of records) {
    const rec = r as { id: string; created_at: string; status: string; route: string; project_name: string };
    store.set("fb:" + rec.id, {
      value: JSON.stringify(r),
      metadata: { t: rec.created_at, s: rec.status, r: rec.route, p: rec.project_name },
    });
  }
  return {
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async put(key: string, value: string, opts?: { metadata?: unknown }) {
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

/** A stored record as the worker would have written it on ingest. */
function record(over: Record<string, unknown> = {}) {
  return {
    schema: 2,
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    created_at: "2026-07-20T09:00:00.000Z",
    project_name: "demo-project",
    app_version: "1.0.0",
    route: "/pricing",
    url: "https://example.test/pricing?token=SECRET",
    body: "the price here is confusing",
    reviewer_name: "Dana",
    session_id: "99999999-8888-4777-8666-555555555555",
    anchor: {
      x_pct: 20,
      y_pct: 15,
      selector: "#cta",
      viewport: { w: 800, h: 600 },
      element: { tag: "button", text: "Buy now", rect: { x: 1, y: 2, w: 3, h: 4 } },
      context: { heading: "Pricing", landmark: "main" },
    },
    env: { user_agent: "Mozilla/5.0 (very identifying)", language: "en-NZ", dark: false },
    page_errors: ["TypeError: prices is undefined"],
    status: "open",
    received_at: "2026-07-20T09:00:01.000Z",
    resolved_at: null,
    resolution_note: null,
    ...over,
  };
}

const ctx = { waitUntil() {} };

function get(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { method: "GET", headers });
}

describe("worker GET /shared", () => {
  it("404s when TYREKICK_REVIEW_KEY is unset (feature off, existence not advertised)", async () => {
    const env = { FEEDBACK: fakeKV([record()]) } as never;
    const res = await worker.fetch(
      get("https://w.test/shared?project=demo-project", { "X-Tyrekick-Review-Key": "anything" }),
      env,
      ctx as never,
    );
    expect(res.status).toBe(404);
  });

  it("401s on a wrong or missing key", async () => {
    const env = { FEEDBACK: fakeKV([record()]), TYREKICK_REVIEW_KEY: "rk-secret" } as never;
    expect((await worker.fetch(get("https://w.test/shared?project=p"), env, ctx as never)).status).toBe(401);
    const wrong = await worker.fetch(
      get("https://w.test/shared?project=p", { "X-Tyrekick-Review-Key": "nope" }),
      env,
      ctx as never,
    );
    expect(wrong.status).toBe(401);
  });

  it("requires a project scope so one key cannot read another prototype", async () => {
    const env = { FEEDBACK: fakeKV([record()]), TYREKICK_REVIEW_KEY: "rk-secret" } as never;
    const res = await worker.fetch(
      get("https://w.test/shared", { "X-Tyrekick-Review-Key": "rk-secret" }),
      env,
      ctx as never,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("project_required");
  });

  it("returns only the requested project's pins", async () => {
    const env = {
      FEEDBACK: fakeKV([
        record(),
        record({ id: "11111111-2222-4333-8444-555555555555", project_name: "other-project" }),
      ]),
      TYREKICK_REVIEW_KEY: "rk-secret",
    } as never;
    const res = await worker.fetch(
      get("https://w.test/shared?project=demo-project", { "X-Tyrekick-Review-Key": "rk-secret" }),
      env,
      ctx as never,
    );
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.pins).toHaveLength(1);
    expect(body.pins[0].id).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  });

  it("withholds declined pins so declining removes spam from everyone's page", async () => {
    const env = {
      FEEDBACK: fakeKV([
        record({ status: "declined" }),
        record({ id: "11111111-2222-4333-8444-555555555555", status: "resolved" }),
      ]),
      TYREKICK_REVIEW_KEY: "rk-secret",
    } as never;
    const res = await worker.fetch(
      get("https://w.test/shared?project=demo-project", { "X-Tyrekick-Review-Key": "rk-secret" }),
      env,
      ctx as never,
    );
    const body = await res.json();
    expect(body.pins).toHaveLength(1);
    expect(body.pins[0].status).toBe("resolved");
  });

  it("filters by route when one is given", async () => {
    const env = {
      FEEDBACK: fakeKV([
        record(),
        record({ id: "11111111-2222-4333-8444-555555555555", route: "/about" }),
      ]),
      TYREKICK_REVIEW_KEY: "rk-secret",
    } as never;
    const res = await worker.fetch(
      get("https://w.test/shared?project=demo-project&route=%2Fabout", {
        "X-Tyrekick-Review-Key": "rk-secret",
      }),
      env,
      ctx as never,
    );
    const body = await res.json();
    expect(body.pins).toHaveLength(1);
    expect(body.pins[0].route).toBe("/about");
  });

  it("matches on pathname, so inbound links with different query strings share one conversation", async () => {
    // Three reviewers reached /pricing by three different links.
    const env = {
      FEEDBACK: fakeKV([
        record({ id: "aaaaaaaa-1111-4ccc-8ddd-eeeeeeeeeeee", route: "/pricing" }),
        record({ id: "aaaaaaaa-2222-4ccc-8ddd-eeeeeeeeeeee", route: "/pricing?utm_source=slack" }),
        record({ id: "aaaaaaaa-3333-4ccc-8ddd-eeeeeeeeeeee", route: "/pricing#plans" }),
        record({ id: "aaaaaaaa-4444-4ccc-8ddd-eeeeeeeeeeee", route: "/pricing-archive" }),
      ]),
      TYREKICK_REVIEW_KEY: "rk-secret",
    } as never;
    const res = await worker.fetch(
      get("https://w.test/shared?project=demo-project&route=%2Fpricing", {
        "X-Tyrekick-Review-Key": "rk-secret",
      }),
      env,
      ctx as never,
    );
    const body = await res.json();
    // All three see each other — and a different page does not bleed in.
    expect(body.pins).toHaveLength(3);
    expect(body.pins.map((p: { route: string }) => p.route)).not.toContain("/pricing-archive");
  });

  it("treats /page and /page/ as one page, whichever way each reviewer arrived", async () => {
    // A full page load follows the host's directory redirect to "/docs/";
    // client-side navigation stays on "/docs". Same page, same conversation.
    const env = {
      FEEDBACK: fakeKV([
        record({ id: "bbbbbbbb-1111-4ccc-8ddd-eeeeeeeeeeee", route: "/docs/setup" }),
        record({ id: "bbbbbbbb-2222-4ccc-8ddd-eeeeeeeeeeee", route: "/docs/setup/" }),
        record({ id: "bbbbbbbb-3333-4ccc-8ddd-eeeeeeeeeeee", route: "/docs/setup-archive/" }),
        record({ id: "bbbbbbbb-4444-4ccc-8ddd-eeeeeeeeeeee", route: "/" }),
      ]),
      TYREKICK_REVIEW_KEY: "rk-secret",
    } as never;
    for (const asked of ["/docs/setup", "/docs/setup/"]) {
      const res = await worker.fetch(
        get(`https://w.test/shared?project=demo-project&route=${encodeURIComponent(asked)}`, { "X-Tyrekick-Review-Key": "rk-secret" }),
        env,
        ctx as never,
      );
      const body = await res.json();
      expect(body.pins.map((p: { route: string }) => p.route).sort()).toEqual(["/docs/setup", "/docs/setup/"]);
    }
    // The root page stays the root page.
    const root = await worker.fetch(
      get("https://w.test/shared?project=demo-project&route=%2F", { "X-Tyrekick-Review-Key": "rk-secret" }),
      env,
      ctx as never,
    );
    expect((await root.json()).pins.map((p: { route: string }) => p.route)).toEqual(["/"]);
  });

  it("never exposes another reviewer's env, page_errors, url or session_id", async () => {
    const env = { FEEDBACK: fakeKV([record()]), TYREKICK_REVIEW_KEY: "rk-secret" } as never;
    const res = await worker.fetch(
      get("https://w.test/shared?project=demo-project", { "X-Tyrekick-Review-Key": "rk-secret" }),
      env,
      ctx as never,
    );
    const raw = await res.text();
    // Assert on the serialised response: a nested leak would slip past key checks.
    expect(raw).not.toContain("Mozilla");
    expect(raw).not.toContain("page_errors");
    expect(raw).not.toContain("session_id");
    expect(raw).not.toContain("SECRET"); // the url's query string
    const pin = JSON.parse(raw).pins[0];
    expect(pin.env).toBeUndefined();
    expect(pin.url).toBeUndefined();
    // …while still carrying what a reader needs.
    expect(pin.body).toBe("the price here is confusing");
    expect(pin.reviewer_name).toBe("Dana");
    expect(pin.anchor.selector).toBe("#cta");
    expect(pin.anchor.element.text).toBe("Buy now");
  });

  it("rejects non-GET methods", async () => {
    const env = { FEEDBACK: fakeKV(), TYREKICK_REVIEW_KEY: "rk-secret" } as never;
    const res = await worker.fetch(
      new Request("https://w.test/shared?project=p", { method: "POST" }),
      env,
      ctx as never,
    );
    expect(res.status).toBe(405);
  });

  it("answers GET / with a health summary so a pasted worker URL isn't a bare 405", async () => {
    const env = { FEEDBACK: fakeKV() } as never;
    const res = await worker.fetch(get("https://w.test/"), env, ctx as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe("tyrekick");
    expect(body.routes).toContain("POST /feedback");
  });

  it("never reveals whether the secrets are configured", async () => {
    // Same root response configured and unconfigured: no oracle for whether
    // TYREKICK_TOKEN / TYREKICK_REVIEW_KEY are set on this deployment.
    const bare = { FEEDBACK: fakeKV() } as never;
    const armed = {
      FEEDBACK: fakeKV(),
      TYREKICK_TOKEN: "t",
      TYREKICK_REVIEW_KEY: "rk",
      DISCORD_WEBHOOK: "https://discord.test/hook",
    } as never;
    const a = await (await worker.fetch(get("https://w.test/"), bare, ctx as never)).text();
    const b = await (await worker.fetch(get("https://w.test/"), armed, ctx as never)).text();
    expect(a).toBe(b);
    expect(a).not.toContain("discord.test");
  });

  it("still rejects other methods on the root", async () => {
    const env = { FEEDBACK: fakeKV() } as never;
    const res = await worker.fetch(
      new Request("https://w.test/", { method: "DELETE" }),
      env,
      ctx as never,
    );
    expect(res.status).toBe(405);
  });

  it("leaves the token-gated management surface alone", async () => {
    // A review key must NOT open /feedback — that one grants write/triage.
    const env = { FEEDBACK: fakeKV([record()]), TYREKICK_REVIEW_KEY: "rk-secret" } as never;
    const res = await worker.fetch(
      get("https://w.test/feedback", { "X-Tyrekick-Review-Key": "rk-secret" }),
      env,
      ctx as never,
    );
    expect(res.status).toBe(401);
  });
});

/** A rate-limiter binding that always allows or always blocks, and records keys. */
function fakeLimiter(allow: boolean) {
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }: { key: string }) {
      keys.push(key);
      return { success: allow };
    },
  };
}

const postFeedback = (headers: Record<string, string> = {}) =>
  new Request("https://w.test/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ schema: 2, body: "hi", project_name: "p" }),
  });

describe("worker rate limiting (open routes only)", () => {
  const IP = { "CF-Connecting-IP": "203.0.113.7" };

  it("429s an over-limit ingest, keyed on the client IP", async () => {
    const limiter = fakeLimiter(false);
    const env = { FEEDBACK: fakeKV(), INGEST_LIMITER: limiter } as never;
    const res = await worker.fetch(postFeedback(IP), env, ctx as never);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate_limited");
    expect(res.headers.get("Retry-After")).toBe("60");
    // Must stay CORS-usable — a browser has to be able to read the 429 body.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(limiter.keys).toEqual(["203.0.113.7"]);
  });

  it("lets an under-limit ingest straight through to storage", async () => {
    const env = { FEEDBACK: fakeKV(), INGEST_LIMITER: fakeLimiter(true) } as never;
    const res = await worker.fetch(postFeedback(IP), env, ctx as never);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("no limiter binding = route stays open (older deploys unaffected)", async () => {
    const env = { FEEDBACK: fakeKV() } as never; // no INGEST_LIMITER
    const res = await worker.fetch(postFeedback(IP), env, ctx as never);
    expect(res.status).toBe(200);
  });

  it("does not block when there is no client IP to key on (e.g. local dev)", async () => {
    // A limiter that would block IS present, but no CF-Connecting-IP header.
    const limiter = fakeLimiter(false);
    const env = { FEEDBACK: fakeKV(), INGEST_LIMITER: limiter } as never;
    const res = await worker.fetch(postFeedback(), env, ctx as never); // no IP header
    expect(res.status).toBe(200);
    expect(limiter.keys).toEqual([]); // limiter never consulted without a key
  });

  it("a limiter that throws must never take the route down (fails open)", async () => {
    const env = {
      FEEDBACK: fakeKV(),
      INGEST_LIMITER: { async limit() { throw new Error("rate limiter unavailable"); } },
    } as never;
    const res = await worker.fetch(postFeedback(IP), env, ctx as never);
    expect(res.status).toBe(200);
  });

  it("rate-limits the open GET /receipts via READ_LIMITER", async () => {
    const env = { FEEDBACK: fakeKV(), READ_LIMITER: fakeLimiter(false) } as never;
    const res = await worker.fetch(
      get("https://w.test/receipts?ids=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", IP),
      env,
      ctx as never,
    );
    expect(res.status).toBe(429);
  });

  it("does NOT rate-limit the token-gated GET /feedback (the token is the gate)", async () => {
    // Even with a blocking READ_LIMITER present, the management list is governed
    // by the token, not the IP limiter — it must not 429.
    const env = {
      FEEDBACK: fakeKV([record()]),
      TYREKICK_TOKEN: "t",
      READ_LIMITER: fakeLimiter(false),
      INGEST_LIMITER: fakeLimiter(false),
    } as never;
    const res = await worker.fetch(
      get("https://w.test/feedback", { Authorization: "Bearer t", ...IP }),
      env,
      ctx as never,
    );
    expect(res.status).toBe(200);
  });
});

describe("worker GET /shared — stable numbering", () => {
  const KEY = { "X-Tyrekick-Review-Key": "rk-secret" };
  const URL_ALL = "https://w.test/shared?project=demo-project&route=/pricing";

  /** Three comments on one page, an hour apart, oldest first. */
  function threeInOrder(over: Array<Record<string, unknown>> = [{}, {}, {}]) {
    return [
      record({ id: "10000000-0000-4000-8000-000000000001", created_at: "2026-07-20T09:00:00.000Z", ...over[0] }),
      record({ id: "10000000-0000-4000-8000-000000000002", created_at: "2026-07-20T10:00:00.000Z", ...over[1] }),
      record({ id: "10000000-0000-4000-8000-000000000003", created_at: "2026-07-20T11:00:00.000Z", ...over[2] }),
    ];
  }

  async function numbersById(records: Record<string, unknown>[]) {
    const env = { FEEDBACK: fakeKV(records), TYREKICK_REVIEW_KEY: "rk-secret" } as never;
    const res = await worker.fetch(get(URL_ALL, KEY), env, ctx as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pins: Array<{ id: string; n: number }> };
    return new Map(body.pins.map((p) => [p.id.slice(-1), p.n]));
  }

  it("numbers by created_at, oldest first, regardless of response order", async () => {
    const n = await numbersById(threeInOrder());
    expect([n.get("1"), n.get("2"), n.get("3")]).toEqual([1, 2, 3]);
  });

  it("keeps every surviving number when one is declined, leaving a gap", async () => {
    const before = await numbersById(threeInOrder());
    expect(before.get("3")).toBe(3);

    // Decline the middle one. It leaves the view; #1 and #3 must not move.
    const after = await numbersById(threeInOrder([{}, { status: "declined" }, {}]));
    expect(after.has("2")).toBe(false);
    expect(after.get("1")).toBe(1);
    expect(after.get("3")).toBe(3); // NOT 2 — a quoted "#3" still means this one
  });

  it("keeps numbers when a comment is resolved (it stays visible and stays put)", async () => {
    const after = await numbersById(
      threeInOrder([{ status: "resolved", resolved_at: "2026-07-21T00:00:00.000Z" }, {}, {}]),
    );
    expect([after.get("1"), after.get("2"), after.get("3")]).toEqual([1, 2, 3]);
  });

  it("gives a new comment the next number without disturbing the existing ones", async () => {
    const after = await numbersById([
      ...threeInOrder(),
      record({ id: "10000000-0000-4000-8000-000000000004", created_at: "2026-07-20T12:00:00.000Z" }),
    ]);
    expect([after.get("1"), after.get("2"), after.get("3"), after.get("4")]).toEqual([1, 2, 3, 4]);
  });

  it("does not let another page's comments consume this page's numbers", async () => {
    const after = await numbersById([
      ...threeInOrder(),
      record({ id: "10000000-0000-4000-8000-000000000009", created_at: "2026-07-20T09:30:00.000Z", route: "/about" }),
    ]);
    expect([after.get("1"), after.get("2"), after.get("3")]).toEqual([1, 2, 3]);
  });

  it("breaks identical timestamps deterministically rather than by KV order", async () => {
    const same = "2026-07-20T09:00:00.000Z";
    const first = await numbersById(threeInOrder([{ created_at: same }, { created_at: same }, {}]));
    const again = await numbersById(threeInOrder([{ created_at: same }, { created_at: same }, {}]));
    expect(first.get("1")).toBe(again.get("1"));
    expect(first.get("2")).toBe(again.get("2"));
    expect(first.get("1")).not.toBe(first.get("2"));
  });
});
