/**
 * Selector generator: deepest HOST element at the point, max 5 segments, or
 * null on error. It must NEVER throw and must NEVER return the widget's own
 * host / shadow nodes. We exercise it through the public payload flow while
 * controlling what elementFromPoint / elementsFromPoint report.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { init, destroy } from "../../src/index";
import {
  installLayout,
  mockFetch,
  mockPointStack,
  submitFeedback,
  getHost,
  cleanup,
  segmentCount,
} from "./helpers";

const CONFIG = {
  webhook: "https://example.test/hook",
  appVersion: "1.0.0",
};

describe("selector generation", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installLayout({ docW: 1000, docH: 2000, vw: 800, vh: 600 });
    fetchMock = mockFetch({ status: 200 });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    errorSpy.mockRestore();
    await cleanup(destroy);
  });

  async function selectorFor(topDown: Array<Element | null>): Promise<string | null> {
    mockPointStack(topDown);
    const p = await submitFeedback({ x: 250, y: 500, body: "sel", fetchMock });
    return p.anchor.selector as string | null;
  }

  it("returns a selector referencing the page target (id preferred)", async () => {
    const el = document.createElement("button");
    el.id = "save-btn";
    document.body.appendChild(el);
    init(CONFIG);
    const sel = await selectorFor([el]);
    expect(sel).not.toBeNull();
    expect(sel!).toContain("save-btn");
    expect(segmentCount(sel!)).toBeLessThanOrEqual(5);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("never returns the widget's own host or shadow nodes", async () => {
    const pageTarget = document.createElement("section");
    pageTarget.id = "page-content";
    document.body.appendChild(pageTarget);

    init(CONFIG);
    const host = getHost();
    // In a real browser, elementsFromPoint retargets shadow-internal hits to the
    // HOST element, so the widget appears in the stack as its host. The selector
    // logic must skip the host and resolve the real page element beneath it.
    const sel = await selectorFor([host, pageTarget]);

    expect(sel).not.toBeNull();
    // The selector must not reference the host element or shadow-internal nodes.
    const hostId = host.id ? `#${host.id}` : null;
    if (hostId) expect(sel!).not.toContain(hostId);
    if (host.tagName) {
      // If the host has a bespoke tag name, it must not appear as the target.
      expect(sel!.toLowerCase()).not.toBe(host.tagName.toLowerCase());
    }
    // It should reference the real page content instead.
    expect(sel!).toContain("page-content");
  });

  it("never throws on a detached node and returns null or <=5 segments", async () => {
    const detached = document.createElement("div"); // not attached to document
    const child = document.createElement("span");
    detached.appendChild(child);
    init(CONFIG);
    const sel = await selectorFor([child, detached]);
    expect(sel === null || segmentCount(sel) <= 5).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("never throws on SVG elements", async () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const rect = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "rect",
    );
    svg.appendChild(rect);
    document.body.appendChild(svg);
    init(CONFIG);
    const sel = await selectorFor([rect, svg]);
    expect(sel === null || segmentCount(sel) <= 5).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("never throws on element with no id or class", async () => {
    const el = document.createElement("article");
    document.body.appendChild(el);
    init(CONFIG);
    const sel = await selectorFor([el]);
    expect(sel === null || segmentCount(sel) <= 5).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("caps deeply nested DOM at 5 selector segments", async () => {
    let node = document.body;
    let deepest: HTMLElement = document.body;
    for (let i = 0; i < 25; i++) {
      const d = document.createElement("div"); // no id/class anywhere
      node.appendChild(d);
      node = d;
      deepest = d;
    }
    init(CONFIG);
    const sel = await selectorFor([deepest]);
    expect(sel === null || segmentCount(sel) <= 5).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("handles a null hit-test result without throwing", async () => {
    init(CONFIG);
    const sel = await selectorFor([]); // elementFromPoint -> null
    expect(sel).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
