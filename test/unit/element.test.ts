/**
 * Schema-v2 anchor.element / anchor.context capture: element identity (never
 * input values), 80-char text clipping, nearest-heading lookup (ancestor +
 * preceding sibling), and the coarse landmark path. All exercised through the
 * public payload flow with a controlled hit-test stack.
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

describe("anchor.element / anchor.context capture", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    installLayout({ docW: 1000, docH: 2000, vw: 800, vh: 600 });
    fetchMock = mockFetch({ status: 200 });
  });

  afterEach(async () => {
    await cleanup(destroy);
  });

  async function anchorFor(target: Element | null): Promise<any> {
    mockPointStack(target ? [target] : []);
    const p = await submitFeedback({ x: 250, y: 500, body: "el", fetchMock });
    return p.anchor;
  }

  it("captures tag / id / testid / role / label / rect for the clicked element", async () => {
    const el = document.createElement("button");
    el.id = "save";
    el.setAttribute("data-testid", "save-btn");
    el.setAttribute("role", "menuitem");
    el.setAttribute("aria-label", "Save the document");
    el.textContent = "Save";
    document.body.appendChild(el);
    init(CONFIG);
    const a = await anchorFor(el);
    expect(a.element).toEqual({
      tag: "button",
      id: "save",
      testid: "save-btn",
      role: "menuitem",
      text: "Save",
      label: "Save the document",
      rect: { x: 0, y: 0, w: 200, h: 120 }, // stubbed getBoundingClientRect
    });
  });

  it("element is null (and context nulls) when no element resolves", async () => {
    init(CONFIG);
    const a = await anchorFor(null);
    expect(a.element).toBeNull();
    expect(a.context).toEqual({ heading: null, landmark: null });
  });

  it("NEVER captures the value of an <input> — text is null", async () => {
    const el = document.createElement("input");
    el.setAttribute("value", "hunter2-secret");
    el.value = "hunter2-secret";
    el.placeholder = "Password";
    document.body.appendChild(el);
    init(CONFIG);
    mockPointStack([el]);
    const p = await submitFeedback({ x: 250, y: 500, body: "pw", fetchMock });
    expect(p.anchor.element.tag).toBe("input");
    expect(p.anchor.element.text).toBeNull();
    // placeholder may serve as the label — the VALUE must never appear anywhere
    expect(p.anchor.element.label).toBe("Password");
    expect(JSON.stringify(p)).not.toContain("hunter2-secret");
  });

  it("NEVER captures <textarea> content", async () => {
    const el = document.createElement("textarea");
    el.textContent = "private textarea value";
    el.value = "private textarea value";
    document.body.appendChild(el);
    init(CONFIG);
    mockPointStack([el]);
    const p = await submitFeedback({ x: 250, y: 500, body: "ta", fetchMock });
    expect(p.anchor.element.text).toBeNull();
    expect(JSON.stringify(p)).not.toContain("private textarea value");
  });

  it("text is null for <select> too", async () => {
    const el = document.createElement("select");
    const opt = document.createElement("option");
    opt.textContent = "Secret Option";
    el.appendChild(opt);
    document.body.appendChild(el);
    init(CONFIG);
    const a = await anchorFor(el);
    expect(a.element.tag).toBe("select");
    expect(a.element.text).toBeNull();
  });

  it("collapses whitespace and truncates visible text at 80 chars", async () => {
    const el = document.createElement("div");
    el.textContent = "  a   b\n\t" + "x".repeat(200) + "  ";
    document.body.appendChild(el);
    init(CONFIG);
    const a = await anchorFor(el);
    expect(a.element.text.length).toBe(80);
    expect(a.element.text.startsWith("a b x")).toBe(true);
    expect(a.element.text).not.toMatch(/\s{2,}|\n|\t/);
  });

  it("truncates label at 80 chars and falls back through alt/placeholder/title", async () => {
    const el = document.createElement("img");
    el.setAttribute("alt", "y".repeat(200));
    document.body.appendChild(el);
    init(CONFIG);
    const a = await anchorFor(el);
    expect(a.element.label.length).toBe(80);
  });

  it("finds the nearest heading from an ancestor", async () => {
    const h = document.createElement("h2");
    h.textContent = "  Billing   settings  ";
    const span = document.createElement("span");
    h.appendChild(span);
    document.body.appendChild(h);
    init(CONFIG);
    const a = await anchorFor(span);
    expect(a.context.heading).toBe("Billing settings");
  });

  it("finds the nearest heading from a preceding sibling while walking up", async () => {
    const section = document.createElement("section");
    const h3 = document.createElement("h3");
    h3.textContent = "Pricing plans";
    const wrap = document.createElement("div");
    const btn = document.createElement("button");
    btn.textContent = "Buy";
    wrap.appendChild(btn);
    section.appendChild(h3);
    section.appendChild(wrap);
    document.body.appendChild(section);
    init(CONFIG);
    const a = await anchorFor(btn);
    expect(a.context.heading).toBe("Pricing plans");
  });

  it("builds the landmark path (innermost last, ids included)", async () => {
    const main = document.createElement("main");
    const section = document.createElement("section");
    section.id = "pricing";
    const btn = document.createElement("button");
    section.appendChild(btn);
    main.appendChild(section);
    document.body.appendChild(main);
    init(CONFIG);
    const a = await anchorFor(btn);
    expect(a.context.landmark).toBe("main > section#pricing");
  });

  it("caps the landmark path at 3 segments (innermost 3)", async () => {
    const main = document.createElement("main");
    const section = document.createElement("section");
    section.id = "a";
    const article = document.createElement("article");
    const form = document.createElement("form");
    const btn = document.createElement("button");
    form.appendChild(btn);
    article.appendChild(form);
    section.appendChild(article);
    main.appendChild(section);
    document.body.appendChild(main);
    init(CONFIG);
    const a = await anchorFor(btn);
    expect(a.context.landmark).toBe("section#a > article > form");
  });
});
