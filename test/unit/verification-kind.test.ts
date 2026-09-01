/**
 * Connectivity checks must not look like feedback.
 *
 * `tyrekick init` and the make-reviewable skill each POST a comment to prove the
 * pipe works. Stored as "open", they sat in the queue forever: across 17 live
 * workers, 16 of 31 open comments were the tooling talking about itself, and
 * seven projects reported a backlog no human had written.
 */
import { describe, it, expect } from "vitest";
import worker from "../../destinations/cloudflare/worker";

function fakeKV() {
  const store = new Map<string, { value: string; metadata: unknown }>();
  return {
    store,
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

const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function post(over: Record<string, unknown> = {}) {
  return new Request("https://w.test/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema: 2,
      id: ID,
      project_name: "demo",
      app_version: "1.0.0",
      route: "/",
      url: "tyrekick-init-test",
      body: "Test comment from `tyrekick` — the widget is wired up.",
      anchor: { x_pct: 0, y_pct: 0, selector: null, viewport: { w: 0, h: 0 } },
      ...over,
    }),
  });
}

const ctx = () => {
  const tasks: Promise<unknown>[] = [];
  return { tasks, ctx: { waitUntil: (p: Promise<unknown>) => void tasks.push(p) } };
};

const stored = (kv: ReturnType<typeof fakeKV>) =>
  JSON.parse(kv.store.get("fb:" + ID)!.value) as Record<string, unknown>;

describe('kind: "verification"', () => {
  it("is stored already resolved, with a note saying why", async () => {
    const kv = fakeKV();
    const { ctx: c } = ctx();
    const res = await worker.fetch(post({ kind: "verification" }), { FEEDBACK: kv } as never, c as never);
    expect(res.status).toBe(200);
    const rec = stored(kv);
    expect(rec.status).toBe("resolved");
    expect(rec.resolved_at).toEqual(rec.received_at);
    expect(rec.resolution_note).toMatch(/connectivity check/i);
  });

  it("does not appear in the open list", async () => {
    const kv = fakeKV();
    const { ctx: c } = ctx();
    await worker.fetch(post({ kind: "verification" }), { FEEDBACK: kv } as never, c as never);
    const list = await worker.fetch(
      new Request("https://w.test/feedback?status=open", { headers: { Authorization: "Bearer t" } }),
      { FEEDBACK: kv, TYREKICK_TOKEN: "t" } as never,
      c as never,
    );
    const body = (await list.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("still mirrors to Discord — the check exists to prove that path works", async () => {
    const kv = fakeKV();
    const { ctx: c, tasks } = ctx();
    await worker.fetch(
      post({ kind: "verification" }),
      { FEEDBACK: kv, DISCORD_WEBHOOK: "https://discord.test/x" } as never,
      c as never,
    );
    expect(tasks.length).toBe(1);
  });

  it("does not spend an AI reply on itself", async () => {
    const kv = fakeKV();
    const { ctx: c, tasks } = ctx();
    await worker.fetch(
      post({ kind: "verification" }),
      { FEEDBACK: kv, ANTHROPIC_API_KEY: "k" } as never,
      c as never,
    );
    expect(tasks).toEqual([]);
  });

  // Back-compat: every browser payload, and every client older than this field.
  it("a payload with no kind is still stored open", async () => {
    const kv = fakeKV();
    const { ctx: c } = ctx();
    await worker.fetch(post(), { FEEDBACK: kv } as never, c as never);
    const rec = stored(kv);
    expect(rec.status).toBe("open");
    expect(rec.resolved_at).toBeNull();
    expect(rec.resolution_note).toBeNull();
  });

  it("an unrecognised kind is treated as a real comment, not silently hidden", async () => {
    const kv = fakeKV();
    const { ctx: c } = ctx();
    await worker.fetch(post({ kind: "something-else" }), { FEEDBACK: kv } as never, c as never);
    expect(stored(kv).status).toBe("open");
  });
});
