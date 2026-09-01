/**
 * Review window (client side).
 *
 * Transport: a failure body's typed `error` reaches the caller, and ONLY
 * `review_closed` skips the retry — everything else still gets its second
 * attempt, which is what stops the retry-skip being generalised later.
 *
 * UI: a closed review is a permanent refusal, so the reviewer is told so and
 * the retry affordance is taken away — but the text is never lost.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { init, destroy } from "../../src/index";
import { send } from "../../src/transport/webhook";
import type { FeedbackPayload } from "../../src/types";
import {
  installLayout,
  mockPointStack,
  submitFeedback,
  getShadow,
  dialog,
  cleanup,
} from "./helpers";

const CONFIG = {
  webhook: "https://example.test/feedback",
  appVersion: "1.0.0",
};

/* -- transport -------------------------------------------------------------- */

const payload = {
  schema: 2,
  id: "11111111-2222-4333-8444-555555555555",
  project_name: "demo",
  app_version: "1.0.0",
  route: "/",
  url: "https://example.test/",
  body: "hi",
  anchor: { x_pct: 1, y_pct: 2, selector: "#cta", viewport: { w: 800, h: 600 } },
} as unknown as FeedbackPayload;

/** One response body per attempt; drives send() past its 2s backoff on fake timers. */
async function attempt(
  responses: Array<{ status: number; body: unknown }>,
  transport: "json" | "discord" = "json",
) {
  let n = 0;
  const fetchMock = vi.fn(async () => {
    const r = responses[Math.min(n++, responses.length - 1)];
    if (!r) throw new Error("network down");
    const text = r.body == null ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      async text() {
        return text;
      },
    };
  });
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  vi.useFakeTimers();
  try {
    const p = send(CONFIG.webhook, transport, payload);
    await vi.advanceTimersByTimeAsync(3000); // clears the 2s retry backoff
    return { res: await p, calls: fetchMock.mock.calls.length };
  } finally {
    vi.useRealTimers();
  }
}

/** A fetch that rejects outright (DNS failure / offline). */
async function rejecting() {
  const fetchMock = vi.fn(async () => {
    throw new Error("network down");
  });
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  vi.useFakeTimers();
  try {
    const p = send(CONFIG.webhook, "json", payload);
    await vi.advanceTimersByTimeAsync(3000);
    return { res: await p, calls: fetchMock.mock.calls.length };
  } finally {
    vi.useRealTimers();
  }
}

describe("transport — typed failures and the retry", () => {
  it("propagates review_closed and does NOT retry", async () => {
    const { res, calls } = await attempt([
      { status: 403, body: { ok: false, error: "review_closed", open_until: "2026-08-28T00:00:00.000Z" } },
    ]);
    expect(res).toEqual({ ok: false, error: "review_closed" });
    expect(calls).toBe(1);
  });

  // The guard against generalising the skip to "any typed error": a form
  // backend that transiently answers {"ok":false} must still get its retry.
  it("propagates any other typed error and STILL retries", async () => {
    const { res, calls } = await attempt([{ status: 500, body: { ok: false, error: "storage_failed" } }]);
    expect(res).toEqual({ ok: false, error: "storage_failed" });
    expect(calls).toBe(2);
  });

  it("retries a review_closed only if the FIRST attempt was something else", async () => {
    const { res, calls } = await attempt([
      { status: 500, body: { ok: false, error: "storage_failed" } },
      { status: 403, body: { ok: false, error: "review_closed" } },
    ]);
    expect(res).toEqual({ ok: false, error: "review_closed" });
    expect(calls).toBe(2);
  });

  // Regression set — every verdict below held before the window existed.
  it("2xx with an empty body is a success", async () => {
    expect((await attempt([{ status: 200, body: null }])).res).toEqual({ ok: true });
  });

  it("2xx with a non-JSON body is a success (judged on status alone)", async () => {
    expect((await attempt([{ status: 200, body: "thanks!" }])).res).toEqual({ ok: true });
  });

  it('2xx with {"ok":false} is a failure', async () => {
    const { res, calls } = await attempt([{ status: 200, body: { ok: false } }]);
    expect(res.ok).toBe(false);
    expect(res.error).toBeUndefined();
    expect(calls).toBe(2);
  });

  it("a non-2xx with an untyped body is a failure and is retried", async () => {
    const { res, calls } = await attempt([{ status: 502, body: "<html>bad gateway</html>" }]);
    expect(res.ok).toBe(false);
    expect(res.error).toBeUndefined();
    expect(calls).toBe(2);
  });

  it("a network rejection is a failure and is retried", async () => {
    const { res, calls } = await rejecting();
    expect(res).toEqual({ ok: false });
    expect(calls).toBe(2);
  });

  it("discord 204 is a success; discord 500 fails and is retried", async () => {
    expect((await attempt([{ status: 204, body: null }], "discord")).res).toEqual({ ok: true });
    const bad = await attempt([{ status: 500, body: { ok: false, error: "review_closed" } }], "discord");
    expect(bad.res).toEqual({ ok: false }); // discord never reads the body, so never skips
    expect(bad.calls).toBe(2);
  });
});

/* -- widget UI -------------------------------------------------------------- */

/** A fetch mock that always answers with the given status/body. */
function mockJson(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const text = body == null ? "" : JSON.stringify(body);
  const fn = vi.fn(async () => ({
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
  }));
  (globalThis as { fetch: unknown }).fetch = fn;
  return fn;
}

const CLOSED = { ok: false, error: "review_closed", open_until: "2026-08-28T00:00:00.000Z" };

function composerStatus(): HTMLElement {
  const el = dialog()!.querySelector<HTMLElement>(".status");
  if (!el) throw new Error("composer status node not found");
  return el;
}

function submitButton(): HTMLButtonElement {
  const el = dialog()!.querySelector<HTMLButtonElement>(".btn-submit");
  if (!el) throw new Error("composer submit button not found");
  return el;
}

describe("widget — a closed review is a dead end, not a broken one", () => {
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

  it("composer: says the review closed, disables the button, keeps Copy and the draft", async () => {
    const fetchMock = mockJson(403, CLOSED);
    init(CONFIG);
    await submitFeedback({ x: 250, y: 500, body: "too late, sorry", fetchMock });

    await vi.waitFor(() => expect(composerStatus().textContent).toContain("This review has closed"), {
      timeout: 4000,
    });
    expect(composerStatus().textContent).toContain("This review has closed — your comment wasn't sent.");
    expect(submitButton().disabled).toBe(true);
    // The text is never lost: Copy is still offered and the draft is stored.
    expect(composerStatus().textContent).toContain("Copy your comment");
    expect(localStorage.getItem("tyrekick:draft:" + location.pathname)).toContain("too late, sorry");
    // The pin still reads as failed.
    expect(getShadow().querySelector(".pin.failed")).not.toBeNull();
  });

  it("composer: any other failure still says Couldn't send, with Retry enabled", async () => {
    const fetchMock = mockJson(500, { ok: false, error: "storage_failed" });
    init(CONFIG);
    await submitFeedback({ x: 250, y: 500, body: "server is grumpy", fetchMock });

    await vi.waitFor(() => expect(composerStatus().textContent).toContain("Couldn't send."), {
      timeout: 6000,
    });
    expect(composerStatus().textContent).not.toContain("This review has closed");
    expect(submitButton().disabled).toBe(false);
    expect(submitButton().textContent).toBe("Retry");
  }, 10000);

  it("drawer: retry against a closed review parks the button on 'Review closed'", async () => {
    const fetchMock = mockJson(403, CLOSED);
    init(CONFIG);
    await submitFeedback({ x: 250, y: 500, body: "pinned but unsent", fetchMock });
    await vi.waitFor(() => expect(getShadow().querySelector(".pin.failed")).not.toBeNull(), {
      timeout: 4000,
    });

    getShadow().querySelector<HTMLButtonElement>('[aria-label="View comments"]')!.click();
    const btn = getShadow().querySelector<HTMLButtonElement>('[aria-label^="Retry sending comment"]');
    expect(btn).not.toBeNull();
    btn!.click();

    await vi.waitFor(() => expect(btn!.textContent).toBe("Review closed"), { timeout: 4000 });
    expect(btn!.disabled).toBe(true);
  });

  it("drawer: retry against a generic failure flips back to an enabled Retry", async () => {
    const fetchMock = mockJson(500, { ok: false, error: "storage_failed" });
    init(CONFIG);
    await submitFeedback({ x: 250, y: 500, body: "pinned but unsent", fetchMock });
    await vi.waitFor(() => expect(getShadow().querySelector(".pin.failed")).not.toBeNull(), {
      timeout: 6000,
    });

    getShadow().querySelector<HTMLButtonElement>('[aria-label="View comments"]')!.click();
    const btn = getShadow().querySelector<HTMLButtonElement>('[aria-label^="Retry sending comment"]')!;
    btn.click();
    await vi.waitFor(() => expect(btn.textContent).toBe("Retry"), { timeout: 6000 });
    expect(btn.disabled).toBe(false);
  }, 15000);
});
