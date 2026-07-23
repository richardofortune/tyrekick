import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { init, destroy } from "../../src/index";
import {
  installLayout,
  mockFetch,
  mockPointStack,
  getShadow,
  cleanup,
} from "./helpers";

const CONFIG = {
  webhook: "https://example.test/hook",
  appVersion: "1.0.0",
};

const AI_REPLY = "Thanks — I can see you pinned the search box.";

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

/** Open the drawer via its floating toggle. */
function openDrawer(): HTMLElement {
  getShadow()
    .querySelector<HTMLButtonElement>('[aria-label="View comments"]')!
    .click();
  return getShadow().querySelector<HTMLElement>(".drawer")!;
}

describe("AI auto-reply (widget side)", () => {
  const deliveredId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const receiptsKey = "tyrekick:receipts:" + location.pathname;

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

  it("renders the AI reply with the 🤖 label in the comment thread", async () => {
    seedReceipt(deliveredId);
    mockFetch({
      status: 200,
      body: {
        ok: true,
        receipts: [
          {
            id: deliveredId,
            status: "open",
            resolved_at: null,
            resolution_note: null,
            ai_reply: AI_REPLY,
          },
        ],
      },
    });
    init(CONFIG);

    // The /receipts poll fired at init; wait for the reply to land on the pin.
    await vi.waitFor(() => {
      const drawer = openDrawer();
      const ai = drawer.querySelector(".ai-reply");
      expect(ai).not.toBeNull();
      expect(ai!.textContent).toBe("🤖 " + AI_REPLY);
    });
  });

  it("does NOT resolve or decline the pin from ai_reply alone", async () => {
    seedReceipt(deliveredId);
    mockFetch({
      status: 200,
      body: {
        ok: true,
        receipts: [
          {
            id: deliveredId,
            status: "open",
            resolved_at: null,
            resolution_note: null,
            ai_reply: AI_REPLY,
          },
        ],
      },
    });
    init(CONFIG);

    // Wait until the reply has been applied…
    await vi.waitFor(() => {
      const drawer = openDrawer();
      expect(drawer.querySelector(".ai-reply")).not.toBeNull();
    });
    // …then assert the pin never flipped to a closed state.
    const shadow = getShadow();
    expect(shadow.querySelectorAll(".pin.resolved").length).toBe(0);
    expect(shadow.querySelectorAll(".pin.declined").length).toBe(0);
    const drawer = getShadow().querySelector(".drawer")!;
    expect(drawer.textContent).not.toContain("✓ resolved");
    expect(drawer.textContent).not.toContain("✕ declined");
  });

  it("never persists the AI reply to localStorage", async () => {
    seedReceipt(deliveredId);
    mockFetch({
      status: 200,
      body: {
        ok: true,
        receipts: [
          {
            id: deliveredId,
            status: "open",
            resolved_at: null,
            resolution_note: null,
            ai_reply: AI_REPLY,
          },
        ],
      },
    });
    init(CONFIG);

    await vi.waitFor(() => {
      const drawer = openDrawer();
      expect(drawer.querySelector(".ai-reply")).not.toBeNull();
    });

    // The reply is runtime-only: the receipts store must never carry its text.
    const raw = localStorage.getItem(receiptsKey);
    expect(raw).not.toBeNull();
    expect(raw!).not.toContain(AI_REPLY);
    // And no other tyrekick key should either.
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("tyrekick:")) {
        expect(localStorage.getItem(k)!).not.toContain(AI_REPLY);
      }
    }
  });
});
