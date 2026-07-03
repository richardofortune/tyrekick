/**
 * data-* auto-init attribute parsing (IIFE build / src/auto.ts) and config
 * mapping, plus transport selection (json vs discord).
 *
 * Auto-init reads attributes from document.currentScript on DOMContentLoaded
 * (or immediately if the document is already loaded). We fake currentScript,
 * reset the module registry, and import src/auto fresh so its top-level
 * auto-init runs against our stub.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  installLayout,
  mockFetch,
  mockPointStack,
  getHost,
  getShadow,
  enterCommentMode,
  clickPoint,
  submitFeedback,
  cleanup,
} from "./helpers";

function fakeScript(attrs: Record<string, string>): HTMLScriptElement {
  const s = document.createElement("script");
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  document.head.appendChild(s);
  Object.defineProperty(document, "currentScript", {
    configurable: true,
    get: () => s,
  });
  return s;
}

function shadowText(): string {
  const shadow = getShadow();
  const host = getHost();
  let css = "";
  try {
    for (const sheet of (shadow as unknown as {
      adoptedStyleSheets?: CSSStyleSheet[];
    }).adoptedStyleSheets ?? []) {
      for (const rule of Array.from(sheet.cssRules ?? [])) {
        css += rule.cssText;
      }
    }
  } catch {
    /* ignore */
  }
  const styles = Array.from(shadow.querySelectorAll("style"))
    .map((s) => s.textContent ?? "")
    .join("");
  return [host.outerHTML, shadow.innerHTML, styles, css].join("\n");
}

describe("data-* auto-init parsing", () => {
  let destroyFn: (() => void) | undefined;

  beforeEach(() => {
    installLayout();
    mockFetch({ status: 200 });
    vi.resetModules();
  });

  afterEach(async () => {
    await cleanup(destroyFn);
    destroyFn = undefined;
    Object.defineProperty(document, "currentScript", {
      configurable: true,
      get: () => null,
    });
    document.head.querySelectorAll("script").forEach((s) => s.remove());
  });

  it("auto-inits from data-webhook + data-app-version on the script tag", async () => {
    fakeScript({
      "data-webhook": "https://example.test/auto",
      "data-app-version": "9.9.9",
      "data-project-name": "Auto Project",
      "data-accent": "#ff0000",
      "data-position": "bottom-left",
    });
    const mod = await import("../../src/auto");
    destroyFn = (mod as { destroy?: () => void }).destroy;

    // Config parsed successfully => widget mounted with an accessible trigger.
    const trigger = getShadow().querySelector('[aria-label="Give feedback"]');
    expect(trigger).not.toBeNull();

    // accent maps through to the rendered widget styling.
    expect(shadowText()).toContain("#ff0000");
    // position "bottom-left" corner reflected in the layout.
    expect(shadowText().toLowerCase()).toContain("left");
  });

  it("hides the branding footer when data-branding=\"false\"", async () => {
    mockPointStack([]);
    fakeScript({
      "data-webhook": "https://example.test/auto",
      "data-app-version": "1.0.0",
      "data-branding": "false",
    });
    const mod = await import("../../src/auto");
    destroyFn = (mod as { destroy?: () => void }).destroy;
    // The footer (if any) lives in the composer, so open it before asserting.
    enterCommentMode();
    clickPoint(200, 300);
    expect(getShadow().textContent || "").not.toMatch(/Frontier Operations/i);
  });

  it('data-theme="dark" pins the tk-dark host class', async () => {
    fakeScript({
      "data-webhook": "https://example.test/auto",
      "data-app-version": "1.0.0",
      "data-theme": "dark",
    });
    const mod = await import("../../src/auto");
    destroyFn = (mod as { destroy?: () => void }).destroy;
    expect(getHost().classList.contains("tk-dark")).toBe(true);
    expect(getHost().classList.contains("tk-light")).toBe(false);
  });

  it("theme defaults to auto (resolves prefers-color-scheme; light in this env)", async () => {
    fakeScript({
      "data-webhook": "https://example.test/auto",
      "data-app-version": "1.0.0",
    });
    const mod = await import("../../src/auto");
    destroyFn = (mod as { destroy?: () => void }).destroy;
    // The stubbed matchMedia never matches "(prefers-color-scheme: dark)".
    expect(getHost().classList.contains("tk-light")).toBe(true);
    expect(getHost().classList.contains("tk-dark")).toBe(false);
  });

  it("shows the branding footer by default (branding attribute absent)", async () => {
    mockPointStack([]);
    fakeScript({
      "data-webhook": "https://example.test/auto",
      "data-app-version": "1.0.0",
    });
    const mod = await import("../../src/auto");
    destroyFn = (mod as { destroy?: () => void }).destroy;
    enterCommentMode();
    clickPoint(200, 300);
    expect(getShadow().textContent || "").toMatch(/Frontier Operations/i);
  });
});

describe("accent auto-contrast (accentInk)", () => {
  it("light accents get dark ink for text ON the accent", async () => {
    const { accentInk } = await import("../../src/ui/styles");
    expect(accentInk("#FFC53D")).toBe("#16181D"); // default crayon yellow
    expect(accentInk("#fff")).toBe("#16181D"); // 3-digit form
  });

  it("dark accents get white ink", async () => {
    const { accentInk } = await import("../../src/ui/styles");
    expect(accentInk("#4f46e5")).toBe("#FFFFFF");
    expect(accentInk("#16181D")).toBe("#FFFFFF");
  });

  it("unparseable colours fall back to white ink", async () => {
    const { accentInk } = await import("../../src/ui/styles");
    expect(accentInk("rebeccapurple")).toBe("#FFFFFF");
    expect(accentInk("rgb(255,255,255)")).toBe("#FFFFFF");
  });
});

describe("transport selection", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let destroyFn: (() => void) | undefined;

  beforeEach(() => {
    installLayout({ docW: 1000, docH: 2000, vw: 800, vh: 600 });
    const target = document.createElement("div");
    document.body.appendChild(target);
    mockPointStack([target]);
    fetchMock = mockFetch({ status: 204 });
    vi.resetModules();
  });

  afterEach(async () => {
    await cleanup(destroyFn);
    destroyFn = undefined;
  });

  it("transport 'discord' posts a { content } message, not the raw payload", async () => {
    const { init, destroy } = await import("../../src/index");
    destroyFn = destroy;
    init({
      webhook: "https://discord.test/webhook",
      appVersion: "2.0.0",
      projectName: "Disco",
      transport: "discord",
    });
    const body = await submitFeedback({
      x: 250,
      y: 500,
      body: "discord message body",
      name: "Rev",
      fetchMock,
    });
    // Discord shape: a single `content` string, no schema/anchor fields.
    expect(typeof body.content).toBe("string");
    expect(body.schema).toBeUndefined();
    expect(body.anchor).toBeUndefined();
    expect(body.content).toContain("discord message body");
    expect(body.content).toContain("Disco");
    expect(body.content).toContain("2.0.0");
  });

  it("transport 'json' (default) posts the structured payload", async () => {
    const { init, destroy } = await import("../../src/index");
    destroyFn = destroy;
    init({ webhook: "https://example.test/hook", appVersion: "2.0.0" });
    const body = await submitFeedback({
      x: 250,
      y: 500,
      body: "json body",
      fetchMock,
    });
    expect(body.schema).toBe(2);
    expect(body.body).toBe("json body");
    expect(body.content).toBeUndefined();
  });
});
