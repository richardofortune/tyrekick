import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../destinations/cloudflare/worker";

const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const payload = {
  schema: 2, id: ID, project_name: "demo", app_version: "1.0",
  route: "/", url: "https://example.test/", body: "<b>Fix this</b>",
  reviewer_name: "Dana", anchor: { selector: "#cta", x_pct: 10, y_pct: 20 },
};
const config = {
  DISCORD_WEBHOOK: "https://discord.test/hook",
  NOTIFICATION_WEBHOOK: "https://automation.test/hook",
  NOTIFICATION_WEBHOOK_TOKEN: "webhook-secret",
  RESEND_API_KEY: "resend-secret",
  NOTIFICATION_EMAIL_FROM: "Tyrekick <feedback@example.test>",
  NOTIFICATION_EMAIL_TO: "owner@example.test",
};

function setup(overrides: Record<string, unknown> = {}) {
  const store = new Map<string, string>();
  const env = {
    FEEDBACK: {
      async get(key: string) { return store.get(key) ?? null; },
      async put(key: string, value: string) { store.set(key, value); },
    },
    TYREKICK_TOKEN: "token", ...overrides,
  };
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil(task: Promise<unknown>) { tasks.push(task); } };
  const send = (method = "POST", body: unknown = payload) => worker.fetch(new Request(
    `https://worker.test/feedback${method === "PATCH" ? `/${ID}` : ""}`,
    { method, headers: { "Content-Type": "application/json", Authorization: "Bearer token" }, body: JSON.stringify(body) },
  ), env as never, ctx as never);
  return { store, tasks, send };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("worker notifications", () => {
  it("is opt-in, including partially configured email", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const s = setup({ RESEND_API_KEY: "key", NOTIFICATION_EMAIL_TO: "owner@example.test" });
    expect((await s.send()).status).toBe(200);
    expect(s.tasks).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fans out created feedback to Discord, authenticated JSON, and plain-text email", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const s = setup(config);
    expect((await s.send()).status).toBe(200);
    await Promise.all(s.tasks);
    expect(fetch).toHaveBeenCalledTimes(3);
    const calls = new Map(fetch.mock.calls.map(([url, init]) => [url, init]));
    const hook = calls.get(config.NOTIFICATION_WEBHOOK);
    expect(hook.headers.Authorization).toBe("Bearer webhook-secret");
    expect(hook.redirect).toBe("error");
    expect(JSON.parse(hook.body)).toMatchObject({ event: "feedback.created", feedback: { ...payload, status: "open" } });
    const email = calls.get("https://api.resend.com/emails");
    expect(email.headers.Authorization).toBe("Bearer resend-secret");
    expect(JSON.parse(email.body)).toEqual({
      from: config.NOTIFICATION_EMAIL_FROM, to: [config.NOTIFICATION_EMAIL_TO],
      subject: "[Tyrekick] New feedback: demo", text: expect.stringContaining(payload.body),
    });
    expect(JSON.parse(calls.get(config.DISCORD_WEBHOOK).body).content).toContain(payload.body);
  });

  it.each(["resolved", "declined"])("sends %s events with the closure note", async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const s = setup(config);
    await s.send(); await Promise.all(s.tasks); fetch.mockClear(); s.tasks.length = 0;
    expect((await s.send("PATCH", { status, note: "Done safely" })).status).toBe(200);
    await Promise.all(s.tasks);
    const hook = fetch.mock.calls.find(([url]) => url === config.NOTIFICATION_WEBHOOK)![1];
    expect(JSON.parse(hook.body)).toMatchObject({ event: `feedback.${status}`, feedback: { status, resolution_note: "Done safely" } });
    const email = fetch.mock.calls.find(([url]) => url === "https://api.resend.com/emails")![1];
    expect(JSON.parse(email.body).text).toContain("Done safely");
  });

  it.each(["approved", "open"])("does not send closure notifications for %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    const s = setup(config);
    await s.send(); await Promise.all(s.tasks); s.tasks.length = 0;
    await s.send("PATCH", { status });
    expect(s.tasks).toHaveLength(0);
  });

  it("keeps storage and other destinations working on rejection or network failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn().mockImplementation(async (url) => {
      if (url === config.DISCORD_WEBHOOK) throw new Error("offline");
      return new Response(null, { status: url === config.NOTIFICATION_WEBHOOK ? 500 : 200 });
    });
    vi.stubGlobal("fetch", fetch);
    const s = setup(config);
    expect((await s.send()).status).toBe(200);
    await expect(Promise.all(s.tasks)).resolves.toBeDefined();
    expect(s.store.has(`fb:${ID}`)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledWith("Tyrekick webhook notification failed");
  });

  it("does not notify when storage fails", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const s = setup({ ...config, FEEDBACK: { async put() { throw new Error("offline"); } } });
    expect((await s.send()).status).toBe(500);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("supports unauthenticated webhooks and connectivity checks", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 })); vi.stubGlobal("fetch", fetch);
    const s = setup({ NOTIFICATION_WEBHOOK: config.NOTIFICATION_WEBHOOK });
    await s.send("POST", { ...payload, kind: "verification" }); await Promise.all(s.tasks);
    const init = fetch.mock.calls[0][1];
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toMatchObject({ event: "feedback.created", feedback: { kind: "verification", status: "resolved" } });
  });

  it("rejects insecure webhook URLs without preventing email", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 })); vi.stubGlobal("fetch", fetch);
    const s = setup({ ...config, NOTIFICATION_WEBHOOK: "http://automation.test/hook" });
    await s.send(); await Promise.all(s.tasks);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts a stalled webhook after ten seconds", async () => {
    vi.useFakeTimers(); vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    })); vi.stubGlobal("fetch", fetch);
    const s = setup({ NOTIFICATION_WEBHOOK: config.NOTIFICATION_WEBHOOK });
    await s.send(); await vi.advanceTimersByTimeAsync(10_000); await Promise.all(s.tasks);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
