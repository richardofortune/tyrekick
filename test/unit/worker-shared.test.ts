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
