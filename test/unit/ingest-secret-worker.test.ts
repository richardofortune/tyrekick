/**
 * Trusted-proxy ingest (worker side): TYREKICK_INGEST_SECRET gates INGEST ONLY.
 *
 * As with the review window, the load-bearing test is the first: a worker with
 * no secret configured must accept ingest exactly as before the var existed.
 */
import { describe, it, expect } from "vitest";
import worker from "../../destinations/cloudflare/worker";

function fakeKV() {
  const store = new Map<string, string>();
  const puts: string[] = [];
  return {
    puts,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      puts.push(key);
      store.set(key, value);
    },
    async list() {
      return { keys: [...store.keys()].map((name) => ({ name, metadata: null })), list_complete: true };
    },
  };
}

const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ctx = { waitUntil: () => {} };

function post(url: string, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      schema: 2,
      id: ID,
      project_name: "demo-project",
      app_version: "1.0.0",
      route: "/pricing",
      url: "https://example.test/pricing",
      body: "the price here is confusing",
      anchor: { x_pct: 20, y_pct: 15, selector: "#cta", viewport: { w: 800, h: 600 } },
    }),
  });
}

describe("ingest secret — trusted-proxy ingest", () => {
  it("with NO secret configured, ingest is open exactly as before", async () => {
    for (const secret of [undefined, "", "   "]) {
      const kv = fakeKV();
      const res = await worker.fetch(post("https://w.test/feedback"), { FEEDBACK: kv, TYREKICK_INGEST_SECRET: secret } as never, ctx as never);
      expect(res.status).toBe(200);
      expect(kv.puts).toEqual(["fb:" + ID]);
    }
  });

  it.each([
    ["missing", {}],
    ["wrong", { "X-Tyrekick-Ingest-Secret": "nope" }],
    ["a prefix of it", { "X-Tyrekick-Ingest-Secret": "s3cr" }],
  ])("refuses ingest with the secret %s, and stores nothing", async (_label, headers) => {
    const kv = fakeKV();
    for (const path of ["https://w.test/feedback", "https://w.test/"]) {
      const res = await worker.fetch(post(path, headers), { FEEDBACK: kv, TYREKICK_INGEST_SECRET: "s3cret" } as never, ctx as never);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "ingest_unauthorized" });
    }
    expect(kv.puts).toEqual([]);
  });

  it("accepts ingest carrying the right secret", async () => {
    const kv = fakeKV();
    const res = await worker.fetch(
      post("https://w.test/feedback", { "X-Tyrekick-Ingest-Secret": "s3cret" }),
      { FEEDBACK: kv, TYREKICK_INGEST_SECRET: "s3cret" } as never,
      ctx as never,
    );
    expect(res.status).toBe(200);
    expect(kv.puts).toEqual(["fb:" + ID]);
  });

  it("is checked before the review window, so outsiders learn nothing about it", async () => {
    const kv = fakeKV();
    const res = await worker.fetch(
      post("https://w.test/feedback"),
      { FEEDBACK: kv, TYREKICK_INGEST_SECRET: "s3cret", TYREKICK_OPEN_UNTIL: "2000-01-01T00:00:00Z" } as never,
      ctx as never,
    );
    expect(res.status).toBe(401);
  });

  it("leaves management reads to the bearer token", async () => {
    const kv = fakeKV();
    const env = { FEEDBACK: kv, TYREKICK_INGEST_SECRET: "s3cret", TYREKICK_TOKEN: "tok" } as never;
    const ok = await worker.fetch(new Request("https://w.test/feedback", { headers: { Authorization: "Bearer tok" } }), env, ctx as never);
    expect(ok.status).toBe(200);
    const denied = await worker.fetch(new Request("https://w.test/feedback", { headers: { "X-Tyrekick-Ingest-Secret": "s3cret" } }), env, ctx as never);
    expect(denied.status).toBe(401);
  });
});
