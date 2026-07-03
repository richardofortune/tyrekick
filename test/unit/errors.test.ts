/**
 * page_errors buffer (schema v2): window "error" + "unhandledrejection"
 * listeners (console is never patched), last 5 messages oldest first, each
 * truncated to 200 chars, [] when captureErrors:false. Verified through the
 * POSTed payload.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { init, destroy } from "../../src/index";
import {
  installLayout,
  mockFetch,
  mockPointStack,
  submitFeedback,
  cleanup,
} from "./helpers";

const CONFIG = {
  webhook: "https://example.test/hook",
  appVersion: "1.0.0",
};

function fireError(message: string): void {
  window.dispatchEvent(new ErrorEvent("error", { message }));
}

function fireRejection(reason: unknown): void {
  // jsdom has no PromiseRejectionEvent constructor; a plain Event with a
  // `reason` property matches what the listener reads.
  const ev = new Event("unhandledrejection");
  (ev as unknown as { reason: unknown }).reason = reason;
  window.dispatchEvent(ev);
}

describe("page_errors capture", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    installLayout({ docW: 1000, docH: 2000, vw: 800, vh: 600 });
    const target = document.createElement("div");
    document.body.appendChild(target);
    mockPointStack([target]);
    fetchMock = mockFetch({ status: 200 });
  });

  afterEach(async () => {
    await cleanup(destroy);
  });

  async function payload(): Promise<any> {
    return submitFeedback({ x: 250, y: 500, body: "errs", fetchMock });
  }

  it("is [] when no errors occurred", async () => {
    init(CONFIG);
    const p = await payload();
    expect(p.page_errors).toEqual([]);
  });

  it("captures window errors and unhandled rejections, oldest first", async () => {
    init(CONFIG);
    fireError("boom one");
    fireRejection(new Error("nope"));
    fireRejection("plain-string-reason");
    const p = await payload();
    expect(p.page_errors).toEqual([
      "boom one",
      "Error: nope",
      "plain-string-reason",
    ]);
  });

  it("keeps only the last 5 messages", async () => {
    init(CONFIG);
    for (let i = 1; i <= 8; i++) fireError("err " + i);
    const p = await payload();
    expect(p.page_errors).toEqual(["err 4", "err 5", "err 6", "err 7", "err 8"]);
  });

  it("truncates each message to 200 chars", async () => {
    init(CONFIG);
    fireError("E".repeat(500));
    const p = await payload();
    expect(p.page_errors).toHaveLength(1);
    expect(p.page_errors[0]).toBe("E".repeat(200));
  });

  it("captureErrors:false → always [] even when errors fire", async () => {
    init({ ...CONFIG, captureErrors: false });
    fireError("should not be recorded");
    fireRejection("nor this");
    const p = await payload();
    expect(p.page_errors).toEqual([]);
  });

  it("does not patch console and does not record console.error calls", async () => {
    init(CONFIG);
    const orig = console.error;
    console.error("logged, not thrown");
    expect(console.error).toBe(orig); // console methods untouched
    const p = await payload();
    expect(p.page_errors).toEqual([]);
  });

  it("destroy() removes the listeners; a fresh init starts with a clean buffer", async () => {
    init(CONFIG);
    fireError("from first session");
    destroy();
    // No widget — dispatching now must be inert and must not throw.
    expect(() => fireError("after destroy")).not.toThrow();
    init(CONFIG);
    const p = await payload();
    expect(p.page_errors).toEqual([]);
  });

  it("data-capture-errors=\"false\" is honoured by auto-init", async () => {
    vi.resetModules();
    const s = document.createElement("script");
    s.setAttribute("data-webhook", "https://example.test/auto");
    s.setAttribute("data-app-version", "1.0.0");
    s.setAttribute("data-capture-errors", "false");
    document.head.appendChild(s);
    Object.defineProperty(document, "currentScript", {
      configurable: true,
      get: () => s,
    });
    const mod = (await import("../../src/auto")) as {
      destroy: () => void;
    };
    try {
      fireError("auto-init should ignore me");
      const p = await payload();
      expect(p.page_errors).toEqual([]);
    } finally {
      mod.destroy();
      Object.defineProperty(document, "currentScript", {
        configurable: true,
        get: () => null,
      });
      s.remove();
    }
  });
});
