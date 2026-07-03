/**
 * init / destroy lifecycle + config validation (CONTRACT.md § Public API).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { init, destroy } from "../../src/index";
import { installLayout, getHost, getShadow, cleanup } from "./helpers";

const CONFIG = {
  webhook: "https://example.test/hook",
  appVersion: "1.0.0",
};

function shadowHostCount(): number {
  return Array.from(document.body.querySelectorAll("*")).filter(
    (el) => (el as HTMLElement).shadowRoot,
  ).length;
}

describe("lifecycle & config validation", () => {
  beforeEach(() => {
    installLayout();
  });

  afterEach(async () => {
    await cleanup(destroy);
  });

  it("throws a clear error when webhook is missing", () => {
    expect(() =>
      init({ appVersion: "1.0.0" } as any),
    ).toThrow(/webhook/i);
  });

  it("throws a clear error when appVersion is missing", () => {
    expect(() =>
      init({ webhook: "https://example.test/hook" } as any),
    ).toThrow(/app.?version/i);
  });

  it("mounts a single shadow host on init", () => {
    init(CONFIG);
    expect(shadowHostCount()).toBe(1);
    // Trigger present + accessible.
    const t = getShadow().querySelector('[aria-label="Give feedback"]');
    expect(t).not.toBeNull();
  });

  it("double init() without destroy warns and is a no-op", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    init(CONFIG);
    init(CONFIG);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(shadowHostCount()).toBe(1); // still exactly one host
    warn.mockRestore();
  });

  it("destroy() removes all widget DOM", () => {
    init(CONFIG);
    expect(shadowHostCount()).toBe(1);
    destroy();
    expect(shadowHostCount()).toBe(0);
    expect(document.body.querySelector('[aria-label="Give feedback"]')).toBeNull();
  });

  it("init() works again after destroy()", () => {
    init(CONFIG);
    const firstHost = getHost();
    destroy();
    expect(shadowHostCount()).toBe(0);
    init(CONFIG);
    expect(shadowHostCount()).toBe(1);
    // A brand-new host, and the trigger is functional again.
    const secondHost = getHost();
    expect(secondHost).not.toBe(firstHost);
    expect(getShadow().querySelector('[aria-label="Give feedback"]')).not.toBeNull();
  });

  it("destroy() is safe to call when not initialized", () => {
    expect(() => destroy()).not.toThrow();
    expect(shadowHostCount()).toBe(0);
  });

  it("destroy() is idempotent (second call is a no-op, no throw)", () => {
    init(CONFIG);
    destroy();
    expect(() => destroy()).not.toThrow();
    expect(shadowHostCount()).toBe(0);
  });

  it("destroy() removes document-level listeners (Esc after destroy is inert)", () => {
    const errors: unknown[] = [];
    window.addEventListener("error", (e) => errors.push(e));
    init(CONFIG);
    destroy();
    // Firing keyboard/pointer events after teardown must not resurrect UI or throw.
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(shadowHostCount()).toBe(0);
    expect(errors).toHaveLength(0);
  });
});
