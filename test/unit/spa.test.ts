/**
 * SPA navigation: pins are keyed by pathname, so a client-side route change
 * (history.pushState / popstate — no reload) must reset per-route state instead
 * of letting the previous view's pins linger. Regression for the "pins persist
 * across views in an SPA" bug.
 */
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

const CONFIG = { webhook: "https://example.test/hook", appVersion: "1.0.0" };

function pinCount(): number {
  return getShadow().querySelectorAll(".pin").length;
}

/** A stored "failed" pin entry as savePins() would write it, for one route. */
function seedFailedPin(pathname: string, body: string): void {
  const entry = [
    {
      i: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      n: 1,
      x: 250,
      y: 500,
      s: "failed",
      a: {
        x_pct: 25,
        y_pct: 25,
        selector: "#cta",
        viewport: { w: 800, h: 600 },
        element: null,
        context: { heading: null, landmark: null },
      },
      b: body,
      r: null,
      t: "2026-07-19T00:00:00.000Z",
      ri: null,
      ex: null,
      ey: null,
    },
  ];
  localStorage.setItem("tyrekick:pins:" + pathname, JSON.stringify(entry));
}

describe("SPA navigation", () => {
  beforeEach(() => {
    installLayout({ docW: 1000, docH: 2000, vw: 800, vh: 600 });
    localStorage.clear();
    history.pushState({}, "", "/"); // start every test from a known route
    const target = document.createElement("button");
    target.id = "cta";
    document.body.appendChild(target);
    mockPointStack([target]);
  });

  afterEach(async () => {
    localStorage.clear();
    history.pushState({}, "", "/");
    await cleanup(destroy);
  });

  it("clears the previous route's pins on client-side navigation", async () => {
    const fetchMock = mockFetch({ status: 200 });
    init(CONFIG);

    await submitFeedback({ x: 250, y: 500, body: "pin on home", fetchMock });
    expect(pinCount()).toBe(1);

    // Soft navigate to a route with no stored pins.
    history.pushState({}, "", "/other");
    await vi.waitFor(() => expect(pinCount()).toBe(0));
  });

  it("restores a route's own pins when navigating (back) to it", async () => {
    mockFetch({ status: 200 });
    // "/back" already has one persisted (failed) pin; the current route has none.
    seedFailedPin("/back", "pin waiting on /back");
    init(CONFIG);
    expect(pinCount()).toBe(0);

    history.pushState({}, "", "/back");
    await vi.waitFor(() => expect(pinCount()).toBe(1));

    // And leaving it again clears it.
    history.pushState({}, "", "/elsewhere");
    await vi.waitFor(() => expect(pinCount()).toBe(0));
  });

  it("ignores query/hash-only changes (same pathname keeps its pins)", async () => {
    const fetchMock = mockFetch({ status: 200 });
    init(CONFIG);
    await submitFeedback({ x: 250, y: 500, body: "sticky pin", fetchMock });
    expect(pinCount()).toBe(1);

    history.pushState({}, "", "/?tab=2#section");
    await Promise.resolve();
    await Promise.resolve();
    expect(pinCount()).toBe(1); // same pathname => no reset
  });

  it("stops following navigation after destroy()", async () => {
    const fetchMock = mockFetch({ status: 200 });
    init(CONFIG);
    await submitFeedback({ x: 250, y: 500, body: "pin", fetchMock });
    expect(pinCount()).toBe(1);

    destroy();
    // No widget, and navigating must not throw or resurrect anything.
    expect(() => history.pushState({}, "", "/after-destroy")).not.toThrow();
    await Promise.resolve();
    expect(document.querySelector("[data-tyrekick]")).toBeNull();
  });
});
