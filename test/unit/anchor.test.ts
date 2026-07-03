/**
 * Anchor math: x_pct / y_pct are percentages of the DOCUMENT dimensions
 * (documentElement.scrollWidth / scrollHeight) at click time, to 1 decimal.
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

describe("anchor percentage math", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mockPointStack([target]);
    fetchMock = mockFetch({ status: 200 });
  });

  afterEach(async () => {
    await cleanup(destroy);
  });

  const cases: Array<{
    name: string;
    docW: number;
    docH: number;
    x: number;
    y: number;
    ex: number;
    ey: number;
  }> = [
    { name: "center", docW: 1000, docH: 2000, x: 250, y: 500, ex: 25, ey: 25 },
    {
      name: "three-quarters",
      docW: 1000,
      docH: 2000,
      x: 750,
      y: 1500,
      ex: 75,
      ey: 75,
    },
    {
      name: "top-left corner",
      docW: 1000,
      docH: 2000,
      x: 100,
      y: 100,
      ex: 10,
      ey: 5,
    },
    {
      name: "odd dimensions rounds to 1 decimal",
      docW: 1280,
      docH: 3200,
      x: 640,
      y: 800,
      ex: 50,
      ey: 25,
    },
  ];

  for (const c of cases) {
    it(`computes x_pct/y_pct for ${c.name}`, async () => {
      installLayout({ docW: c.docW, docH: c.docH, vw: 800, vh: 600 });
      init(CONFIG);
      const p = await submitFeedback({
        x: c.x,
        y: c.y,
        body: "anchor test",
        fetchMock,
      });
      expect(p.anchor.x_pct).toBeCloseTo(c.ex, 5);
      expect(p.anchor.y_pct).toBeCloseTo(c.ey, 5);
    });
  }

  it("is rounded to a single decimal place", async () => {
    installLayout({ docW: 900, docH: 900, vw: 800, vh: 600 });
    init(CONFIG);
    // 100/900 = 11.111...% -> 11.1
    const p = await submitFeedback({
      x: 100,
      y: 100,
      body: "rounding",
      fetchMock,
    });
    expect(p.anchor.x_pct).toBeCloseTo(11.1, 5);
    expect(p.anchor.y_pct).toBeCloseTo(11.1, 5);
    // No more than one fractional digit.
    expect(String(p.anchor.x_pct)).toMatch(/^\d+(\.\d)?$/);
    expect(String(p.anchor.y_pct)).toMatch(/^\d+(\.\d)?$/);
  });

  it("accounts for document scroll offset (document coords, not viewport)", async () => {
    installLayout({
      docW: 1000,
      docH: 2000,
      vw: 800,
      vh: 600,
      scrollX: 100,
      scrollY: 500,
    });
    init(CONFIG);
    // document x = clientX(150) + scrollX(100) = 250 -> 25%
    // document y = clientY(500) + scrollY(500) = 1000 -> 50%
    const p = await submitFeedback({
      x: 150,
      y: 500,
      body: "scrolled",
      fetchMock,
    });
    expect(p.anchor.x_pct).toBeCloseTo(25, 5);
    expect(p.anchor.y_pct).toBeCloseTo(50, 5);
  });

  it("reports the viewport dimensions alongside the anchor", async () => {
    installLayout({ docW: 1000, docH: 2000, vw: 1024, vh: 768 });
    init(CONFIG);
    const p = await submitFeedback({ x: 250, y: 500, body: "vp", fetchMock });
    expect(p.anchor.viewport).toEqual({ w: 1024, h: 768 });
  });
});
