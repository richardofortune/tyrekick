/**
 * Capture chip: text derivation (element text → label → selector → percent
 * fallback), the chip rendered in the composer, and the counter warn state.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chipLabel } from "../../src/ui/panel";
import { init, destroy } from "../../src/index";
import type { FeedbackPayload } from "../../src/types";
import {
  installLayout,
  mockFetch,
  mockPointStack,
  getShadow,
  enterCommentMode,
  clickPoint,
  cleanup,
} from "./helpers";

type Anchor = FeedbackPayload["anchor"];

function anchor(over: Partial<Anchor> = {}): Anchor {
  return {
    x_pct: 25,
    y_pct: 50,
    selector: null,
    viewport: { w: 800, h: 600 },
    element: null,
    context: { heading: null, landmark: null },
    ...over,
  };
}

function element(over: Partial<NonNullable<Anchor["element"]>> = {}) {
  return {
    tag: "div",
    id: null,
    testid: null,
    role: null,
    text: null,
    label: null,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    ...over,
  };
}

describe("capture chip text derivation (chipLabel)", () => {
  it("prefers the element's visible text", () => {
    const a = anchor({
      selector: "main > button",
      element: element({ tag: "button", text: "Save changes", label: "save" }),
    });
    expect(chipLabel(a)).toBe('button "Save changes"');
  });

  it("falls back to the label when there is no text (e.g. inputs)", () => {
    const a = anchor({
      selector: "form > input",
      element: element({ tag: "input", text: null, label: "Email address" }),
    });
    expect(chipLabel(a)).toBe('input "Email address"');
  });

  it("falls back to the selector when the element has no text or label", () => {
    const a = anchor({
      selector: "#hero > div:nth-of-type(2)",
      element: element({ tag: "div" }),
    });
    expect(chipLabel(a)).toBe("#hero > div:nth-of-type(2)");
  });

  it("falls back to document percentages when nothing else resolved", () => {
    const a = anchor({ x_pct: 25.5, y_pct: 50 });
    expect(chipLabel(a)).toBe("25.5%, 50%");
  });
});

describe("capture chip in the composer", () => {
  beforeEach(() => {
    installLayout();
    mockFetch({ status: 200 });
  });

  afterEach(async () => {
    await cleanup(destroy);
  });

  it("renders a mono chip naming the clicked element, with an aria-label", () => {
    const btn = document.createElement("button");
    btn.textContent = "Buy now";
    document.body.appendChild(btn);
    mockPointStack([btn]);

    init({
      webhook: "https://example.test/hook",
      appVersion: "1.0.0",
      persist: false,
    });
    enterCommentMode();
    clickPoint(200, 300);

    const chip = getShadow().querySelector(".chip");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain('button "Buy now"');
    expect(chip!.getAttribute("aria-hidden")).toBe("false");
    expect(chip!.getAttribute("aria-label")).toContain("Commenting on");
    expect(chip!.getAttribute("aria-label")).toContain('button "Buy now"');
  });

  it("counter is normal below 1800 chars and flagged from 1800 on", () => {
    mockPointStack([]);
    init({
      webhook: "https://example.test/hook",
      appVersion: "1.0.0",
      persist: false,
    });
    enterCommentMode();
    clickPoint(200, 300);

    const ta = getShadow().querySelector<HTMLTextAreaElement>("textarea")!;
    const counter = getShadow().querySelector(".counter")!;

    ta.value = "x".repeat(1799);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    expect(counter.textContent).toBe("1799 / 2000");
    expect(counter.classList.contains("warn")).toBe(false);

    ta.value = "x".repeat(1800);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    expect(counter.textContent).toBe("1800 / 2000");
    expect(counter.classList.contains("warn")).toBe(true);
  });
});
