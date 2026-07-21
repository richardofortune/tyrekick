import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { init, destroy } from "../../src/index";
import {
  installLayout,
  mockFetch,
  mockPointStack,
  submitFeedback,
  getShadow,
  cleanup,
} from "./helpers";

const CONFIG = {
  webhook: "https://example.test/feedback",
  appVersion: "1.0.0",
  projectName: "demo-project",
};
const SHARED = { ...CONFIG, reviewKey: "rk-secret" };

const OTHER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** One pin as the worker's /shared projection sends it. */
function sharedPin(over: Record<string, unknown> = {}) {
  return {
    id: OTHER_ID,
    created_at: "2026-07-20T09:00:00.000Z",
    app_version: "1.0.0",
    route: location.pathname,
    body: "the price here is confusing",
    reviewer_name: "Dana",
    status: "open",
    resolved_at: null,
    resolution_note: null,
    anchor: {
      x_pct: 20,
      y_pct: 15,
      selector: "#cta",
      viewport: { w: 800, h: 600 },
      element: null,
      context: { heading: null, landmark: null },
    },
    ...over,
  };
}

/**
 * Route-aware fetch mock: the widget talks to /feedback, /receipts and /shared
 * in the same session, and these tests care which one got what.
 */
function mockRoutes(routes: Record<string, { status?: number; body?: unknown }>) {
  const fn = vi.fn(async (url: unknown) => {
    const u = String(url);
    const key = Object.keys(routes).find((k) => u.includes(k)) ?? "";
    const { status = 404, body = null } = routes[key] ?? {};
    const text = body == null ? "" : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: { get: () => "application/json" },
      async text() {
        return text;
      },
      async json() {
        return body;
      },
    };
  });
  (globalThis as { fetch: unknown }).fetch = fn;
  return fn;
}

describe("shared review (other reviewers' pins)", () => {
  beforeEach(() => {
    installLayout({ docW: 1000, docH: 2000, vw: 800, vh: 600 });
    localStorage.clear();
    const target = document.createElement("button");
    target.id = "cta";
    document.body.appendChild(target);
    mockPointStack([target]);
  });

  afterEach(async () => {
    vi.useRealTimers();
    localStorage.clear();
    await cleanup(destroy);
  });

  it("never calls /shared when no reviewKey is configured", async () => {
    const fetchMock = mockRoutes({ "/receipts": { status: 404 } });
    init(CONFIG);
    await Promise.resolve();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/shared"))).toBe(false);
  });

  it("never calls /shared on the discord transport (write-only by design)", async () => {
    const fetchMock = mockRoutes({ "/shared": { status: 200, body: { ok: true, pins: [] } } });
    init({ ...SHARED, transport: "discord" as const });
    await Promise.resolve();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/shared"))).toBe(false);
  });

  it("sends the review key as a header, scoped to project and route", async () => {
    const fetchMock = mockRoutes({
      "/shared": { status: 200, body: { ok: true, pins: [] } },
      "/receipts": { status: 404 },
    });
    init(SHARED);

    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/shared"));
      expect(call).toBeDefined();
    });
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/shared"))!;
    const url = String(call[0]);
    expect(url).toContain("project=demo-project");
    expect(url).toContain("route=" + encodeURIComponent(location.pathname));
    // The key travels in a header, never the query string (logs, referrers).
    expect(url).not.toContain("rk-secret");
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-Tyrekick-Review-Key"]).toBe("rk-secret");
  });

  it("renders another reviewer's comment as a read-only foreign pin", async () => {
    mockRoutes({
      "/shared": { status: 200, body: { ok: true, pins: [sharedPin()] } },
      "/receipts": { status: 404 },
    });
    init(SHARED);

    await vi.waitFor(() => {
      expect(getShadow().querySelector(".pin.foreign")).not.toBeNull();
    });
    const pin = getShadow().querySelector(".pin.foreign")!;
    expect(pin.getAttribute("aria-label")).toContain("by Dana");
  });

  it("attributes a foreign comment in the drawer and offers no 'Got it'", async () => {
    mockRoutes({
      "/shared": {
        status: 200,
        body: {
          ok: true,
          pins: [
            sharedPin({
              status: "resolved",
              resolved_at: "2026-07-20T10:00:00.000Z",
              resolution_note: "Reworded the tier labels",
            }),
          ],
        },
      },
      "/receipts": { status: 404 },
    });
    init(SHARED);
    await vi.waitFor(() => expect(getShadow().querySelector(".pin.foreign")).not.toBeNull());

    getShadow().querySelector<HTMLButtonElement>('[aria-label="View comments"]')!.click();
    const drawer = getShadow().querySelector(".drawer")!;
    expect(drawer.textContent).toContain("Dana");
    expect(drawer.textContent).toContain("the price here is confusing");
    expect(drawer.querySelector(".entry.foreign")).not.toBeNull();
    // Dismissing someone else's comment would just be undone by the next poll.
    expect(drawer.querySelector('[aria-label^="Dismiss closed comment"]')).toBeNull();
  });

  it("falls back to 'Another reviewer' when the author left no name", async () => {
    mockRoutes({
      "/shared": { status: 200, body: { ok: true, pins: [sharedPin({ reviewer_name: null })] } },
      "/receipts": { status: 404 },
    });
    init(SHARED);
    await vi.waitFor(() => expect(getShadow().querySelector(".pin.foreign")).not.toBeNull());

    getShadow().querySelector<HTMLButtonElement>('[aria-label="View comments"]')!.click();
    expect(getShadow().querySelector(".drawer")!.textContent).toContain("Another reviewer");
  });

  it("never writes foreign pins into localStorage", async () => {
    mockRoutes({
      "/shared": { status: 200, body: { ok: true, pins: [sharedPin()] } },
      "/receipts": { status: 404 },
    });
    init(SHARED);
    await vi.waitFor(() => expect(getShadow().querySelector(".pin.foreign")).not.toBeNull());

    const receipts = localStorage.getItem("tyrekick:receipts:" + location.pathname);
    expect(receipts === null || !receipts.includes(OTHER_ID)).toBe(true);
    const pins = localStorage.getItem("tyrekick:pins:" + location.pathname);
    expect(pins === null || !pins.includes(OTHER_ID)).toBe(true);
  });

  it("does not duplicate your own comment when it comes back in the shared view", async () => {
    const fetchMock = mockRoutes({
      "/feedback": { status: 200, body: { ok: true } },
      "/shared": { status: 200, body: { ok: true, pins: [] } },
      "/receipts": { status: 404 },
    });
    init(SHARED);
    await submitFeedback({ x: 250, y: 500, body: "mine", fetchMock });
    await vi.waitFor(() => expect(getShadow().querySelector(".pin.sent")).not.toBeNull());

    // The worker now returns OUR comment in the shared view, as it would.
    const posted = JSON.parse(
      String((fetchMock.mock.calls.find((c) => String(c[0]).includes("/feedback"))![1] as RequestInit).body),
    ) as { id: string };
    mockRoutes({
      "/shared": {
        status: 200,
        body: { ok: true, pins: [sharedPin({ id: posted.id, body: "mine", reviewer_name: null })] },
      },
      "/receipts": { status: 404 },
    });
    destroy();
    init(SHARED);

    await vi.waitFor(() => expect(getShadow().querySelectorAll(".pin").length).toBeGreaterThan(0));
    // One pin, and it is ours — not a foreign copy of ourselves.
    expect(getShadow().querySelectorAll(".pin").length).toBe(1);
    expect(getShadow().querySelector(".pin.foreign")).toBeNull();
  });

  it("withdraws a foreign pin once the shared view stops returning it", async () => {
    mockRoutes({
      "/shared": { status: 200, body: { ok: true, pins: [sharedPin()] } },
      "/receipts": { status: 404 },
    });
    init(SHARED);
    await vi.waitFor(() => expect(getShadow().querySelector(".pin.foreign")).not.toBeNull());

    // Declined upstream → the worker withholds it → it must leave the page.
    mockRoutes({
      "/shared": { status: 200, body: { ok: true, pins: [] } },
      "/receipts": { status: 404 },
    });
    getShadow().querySelector<HTMLButtonElement>('[aria-label="View comments"]')!.click();

    await vi.waitFor(() => expect(getShadow().querySelector(".pin.foreign")).toBeNull());
  });

  it("is silent when the destination has no /shared route", async () => {
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a);
    try {
      mockRoutes({ "/shared": { status: 404 }, "/receipts": { status: 404 } });
      init(SHARED);
      await new Promise((r) => setTimeout(r, 10));
      expect(getShadow().querySelector(".pin.foreign")).toBeNull();
      expect(errors).toHaveLength(0);
    } finally {
      console.error = orig;
    }
  });
});
