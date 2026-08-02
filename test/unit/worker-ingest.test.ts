import { describe, it, expect } from "vitest";
import worker from "../../destinations/cloudflare/worker";

/** In-memory stand-in for the FEEDBACK KV namespace (get/put/list w/ metadata). */
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
    _store: store,
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

const ctx = { waitUntil() {} };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function payload(over: Record<string, unknown> = {}) {
  return {
    schema: 2,
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    created_at: "2026-07-20T09:00:00.000Z",
    project_name: "demo",
    app_version: "1.0.0",
    route: "/",
    url: "https://example.test/",
    body: "this looks off",
    reviewer_name: "Dana",
    anchor: { x_pct: 1, y_pct: 2, selector: "#x", viewport: { w: 1, h: 1 }, element: { tag: "button", text: "Buy" }, context: {} },
    ...over,
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://w.test/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function stored(env: { FEEDBACK: ReturnType<typeof fakeKV> }, id: string) {
  const raw = await env.FEEDBACK.get("fb:" + id);
  return raw ? JSON.parse(raw) : null;
}

describe("worker POST /feedback — ingest hardening", () => {
  it("accepts a normal payload and stores it open under its (valid UUID) id", async () => {
    const env = { FEEDBACK: fakeKV() } as never;
    const res = await worker.fetch(post(payload()), env, ctx as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.id).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    const rec = await stored(env as never, body.id);
    expect(rec.status).toBe("open");
    expect(rec.body).toBe("this looks off");
  });

  it("rejects an oversized body with 413 (size cap, not just body truncation)", async () => {
    const env = { FEEDBACK: fakeKV() } as never;
    const fat = payload({ page_errors: ["x".repeat(40 * 1024)] }); // huge non-body field
    const res = await worker.fetch(post(fat), env, ctx as never);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("payload_too_large");
  });

  it("does NOT overwrite an existing record — resolved stays resolved (no un-resolve)", async () => {
    const prior = {
      ...payload({ body: "the original comment", reviewer_name: "Alice" }),
      status: "resolved",
      received_at: "2026-07-20T09:00:01.000Z",
      resolved_at: "2026-07-21T10:00:00.000Z",
      resolution_note: "fixed in v2",
      ai_reply: null,
    };
    const env = { FEEDBACK: fakeKV([prior]) } as never;
    // Attacker re-POSTs the same id with different content.
    const res = await worker.fetch(
      post(payload({ body: "HIJACKED", reviewer_name: "Mallory" })),
      env,
      ctx as never,
    );
    expect(res.status).toBe(200); // idempotent ack, not an error
    const rec = await stored(env as never, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(rec.status).toBe("resolved"); // NOT reset to open
    expect(rec.resolution_note).toBe("fixed in v2"); // NOT wiped
    expect(rec.body).toBe("the original comment"); // NOT overwritten
    expect(rec.reviewer_name).toBe("Alice"); // NOT impersonated
  });

  it("replaces a non-canonical client id with a fresh server UUID", async () => {
    const env = { FEEDBACK: fakeKV() } as never;
    const res = await worker.fetch(post(payload({ id: "short-guessable-1" })), env, ctx as never);
    const body = await res.json();
    expect(body.id).not.toBe("short-guessable-1");
    expect(body.id).toMatch(UUID);
    expect(await stored(env as never, "short-guessable-1")).toBeNull();
    expect(await stored(env as never, body.id)).not.toBeNull();
  });

  it("clamps a forged future created_at to the server clock", async () => {
    const env = { FEEDBACK: fakeKV() } as never;
    const res = await worker.fetch(post(payload({ created_at: "3000-01-01T00:00:00.000Z" })), env, ctx as never);
    const rec = await stored(env as never, (await res.clone().json()).id);
    expect(rec.created_at).not.toBe("3000-01-01T00:00:00.000Z");
    expect(Date.parse(rec.created_at)).toBeLessThan(Date.now() + 86_400_000);
  });

  it("clamps flooded page_errors and oversized anchor text", async () => {
    const env = { FEEDBACK: fakeKV() } as never;
    const res = await worker.fetch(
      post(
        payload({
          page_errors: Array.from({ length: 20 }, (_, i) => "e".repeat(400) + i),
          anchor: { x_pct: 1, y_pct: 2, selector: "#x", viewport: { w: 1, h: 1 }, element: { tag: "div", text: "z".repeat(2000) }, context: {} },
        }),
      ),
      env,
      ctx as never,
    );
    const rec = await stored(env as never, (await res.json()).id);
    expect(rec.page_errors.length).toBeLessThanOrEqual(5);
    expect(rec.page_errors[0].length).toBeLessThanOrEqual(300);
    expect(rec.anchor.element.text.length).toBeLessThanOrEqual(300);
  });

  it("still rejects empty body and unsupported schema", async () => {
    const env = { FEEDBACK: fakeKV() } as never;
    expect((await worker.fetch(post(payload({ body: "   " })), env, ctx as never)).status).toBe(400);
    expect((await worker.fetch(post(payload({ schema: 9 })), env, ctx as never)).status).toBe(400);
  });
});
