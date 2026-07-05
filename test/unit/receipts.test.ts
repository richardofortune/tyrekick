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
  webhook: "https://example.test/hook",
  appVersion: "1.0.0",
};

/** Seed one delivered-comment receipt as a previous session would have. */
function seedReceipt(deliveredId: string, body = "seeded delivered comment") {
  localStorage.setItem(
    "tyrekick:receipts:" + location.pathname,
    JSON.stringify([
      {
        d: deliveredId,
        i: "11111111-2222-4333-8444-555555555555",
        n: 1,
        x: 200,
        y: 300,
        a: {
          x_pct: 20,
          y_pct: 15,
          selector: "#cta",
          viewport: { w: 800, h: 600 },
          element: null,
          context: { heading: null, landmark: null },
        },
        b: body,
        r: null,
        t: new Date().toISOString(),
        ri: null,
        ex: null,
        ey: null,
      },
    ]),
  );
}

describe("delivered-comment receipts", () => {
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

  it("stores a receipt after a successful send and restores it as a sent pin", async () => {
    const fetchMock = mockFetch({ status: 200, body: { ok: true } });
    init(CONFIG);
    await submitFeedback({ x: 250, y: 500, body: "receipt me", fetchMock });

    await vi.waitFor(() =>
      expect(localStorage.getItem("tyrekick:receipts:" + location.pathname)).not.toBeNull(),
    );
    const raw = localStorage.getItem("tyrekick:receipts:" + location.pathname);
    const saved = JSON.parse(raw!) as Array<{ d: string; b: string }>;
    expect(saved).toHaveLength(1);
    expect(saved[0].b).toBe("receipt me");
    expect(saved[0].d).toMatch(/^[0-9a-f-]{36}$/i);

    // "Reload": the delivered comment comes back as a sent pin.
    destroy();
    mockFetch({ status: 404, body: null }); // receipts poll fails silently
    init(CONFIG);
    const pin = getShadow().querySelector(".pin");
    expect(pin).not.toBeNull();
    expect(pin!.classList.contains("sent")).toBe(true);
  });

  it("never writes receipts on the discord transport", async () => {
    const fetchMock = mockFetch({ status: 204, body: null });
    init({ ...CONFIG, transport: "discord" as const });
    await submitFeedback({ x: 250, y: 500, body: "discord is write-only", fetchMock });
    expect(localStorage.getItem("tyrekick:receipts:" + location.pathname)).toBeNull();
  });

  it("marks a restored pin resolved when the worker's receipt says so", async () => {
    const deliveredId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    seedReceipt(deliveredId);
    const fetchMock = mockFetch({
      status: 200,
      body: {
        ok: true,
        receipts: [
          {
            id: deliveredId,
            status: "resolved",
            resolved_at: "2026-07-05T01:00:00Z",
            resolution_note: "Moved the CTA above the fold",
          },
        ],
      },
    });
    init(CONFIG);

    // init polls /receipts with the restored capability id
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/receipts?ids=" + deliveredId);

    await vi.waitFor(() => {
      const pin = getShadow().querySelector(".pin");
      expect(pin).not.toBeNull();
      expect(pin!.classList.contains("resolved")).toBe(true);
    });
    expect(getShadow().querySelector(".pin")!.getAttribute("aria-label")).toContain(
      "resolved",
    );
  });

  it("shows the note in the drawer and 'Got it' dismisses the receipt for good", async () => {
    const deliveredId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    seedReceipt(deliveredId);
    mockFetch({
      status: 200,
      body: {
        ok: true,
        receipts: [
          {
            id: deliveredId,
            status: "resolved",
            resolved_at: "2026-07-05T01:00:00Z",
            resolution_note: "Moved the CTA above the fold",
          },
        ],
      },
    });
    init(CONFIG);
    await vi.waitFor(() =>
      expect(getShadow().querySelector(".pin.resolved")).not.toBeNull(),
    );

    getShadow()
      .querySelector<HTMLButtonElement>('[aria-label="View comments"]')!
      .click();
    const drawer = getShadow().querySelector(".drawer")!;
    expect(drawer.textContent).toContain("✓ resolved");
    expect(drawer.textContent).toContain("Moved the CTA above the fold");

    drawer
      .querySelector<HTMLButtonElement>('[aria-label^="Dismiss closed comment"]')!
      .click();
    expect(getShadow().querySelector(".pin")).toBeNull();
    expect(localStorage.getItem("tyrekick:receipts:" + location.pathname)).toBeNull();
  });

  it("drops receipts older than the retention window on save", async () => {
    const fetchMock = mockFetch({ status: 200, body: { ok: true } });
    init(CONFIG);
    await submitFeedback({ x: 250, y: 500, body: "fresh", fetchMock });
    const key = "tyrekick:receipts:" + location.pathname;
    await vi.waitFor(() => expect(localStorage.getItem(key)).not.toBeNull());
    destroy();

    // Age the stored receipt far past the window, then trigger a re-save.
    const arr = JSON.parse(localStorage.getItem(key)!);
    arr[0].t = "2020-01-01T00:00:00Z";
    localStorage.setItem(key, JSON.stringify(arr));

    mockFetch({ status: 404, body: null });
    init(CONFIG);
    // The stale entry is not restored…
    expect(getShadow().querySelector(".pin")).toBeNull();
  });
});
