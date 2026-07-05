/**
 * Shared jsdom test helpers for the Tyrekick unit suite.
 *
 * jsdom has no layout engine, so we install deterministic stubs for the DOM
 * measurement APIs the widget relies on (scrollWidth/Height, innerWidth/Height,
 * getBoundingClientRect, elementFromPoint / elementsFromPoint). Every unit test
 * drives the *public* API (`init` / `destroy` from ../../src/index) and observes
 * the payload the widget POSTs — nothing here imports private modules, so the
 * suite stays valid against any internal file layout that honours the contract.
 *
 * Assumptions (per CONTRACT.md): the widget renders into a single OPEN shadow
 * root on one host element, the trigger has aria-label "Give feedback", the
 * composer is role="dialog" with a <textarea>, and Submit/Cancel are <button>s.
 */
import { vi, expect } from "vitest";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LayoutOpts {
  docW?: number;
  docH?: number;
  vw?: number;
  vh?: number;
  scrollX?: number;
  scrollY?: number;
}

/** Install deterministic layout/measurement stubs on the jsdom document. */
export function installLayout(opts: LayoutOpts = {}): Required<LayoutOpts> {
  const cfg: Required<LayoutOpts> = {
    docW: 1000,
    docH: 2000,
    vw: 800,
    vh: 600,
    scrollX: 0,
    scrollY: 0,
    ...opts,
  };

  const de = document.documentElement;
  defineGetter(de, "scrollWidth", () => cfg.docW);
  defineGetter(de, "scrollHeight", () => cfg.docH);
  defineGetter(de, "clientWidth", () => cfg.vw);
  defineGetter(de, "clientHeight", () => cfg.vh);

  defineValue(window, "innerWidth", cfg.vw);
  defineValue(window, "innerHeight", cfg.vh);
  defineValue(window, "scrollX", cfg.scrollX);
  defineValue(window, "scrollY", cfg.scrollY);
  defineValue(window, "pageXOffset", cfg.scrollX);
  defineValue(window, "pageYOffset", cfg.scrollY);

  // Give elements a sane, non-zero rect so composer flip math never NaNs.
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    const rect = {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 200,
      bottom: 120,
      width: 200,
      height: 120,
    };
    return { ...rect, toJSON: () => rect } as DOMRect;
  };

  (window as unknown as { scrollTo: () => void }).scrollTo = () => {};

  stubEnv();
  return cfg;
}

/** Stub browser APIs jsdom lacks that a widget might reasonably touch. */
export function stubEnv(): void {
  // Deterministic screen metrics for env capture (jsdom reports 0 / 1).
  try {
    Object.defineProperty(window, "screen", {
      configurable: true,
      value: { width: 1280, height: 720 },
    });
  } catch {
    /* keep jsdom's own screen */
  }
  defineValue(window, "devicePixelRatio", 2);
  if (typeof window.matchMedia !== "function") {
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }
  for (const name of ["ResizeObserver", "IntersectionObserver"] as const) {
    if (typeof (globalThis as Record<string, unknown>)[name] !== "function") {
      (globalThis as Record<string, unknown>)[name] = class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      };
    }
  }
}

/**
 * Mock what `document.elementFromPoint` / `elementsFromPoint` report at the
 * click location. `stack[0]` is the topmost node. Per the contract the widget
 * must skip its own nodes, so tests pass the *page* target as what a
 * pointer-events:none capture layer would reveal via elementFromPoint.
 */
export function mockPointStack(topDown: Array<Element | null>): void {
  const clean = topDown.filter((n): n is Element => !!n);
  (document as unknown as { elementFromPoint: unknown }).elementFromPoint = () =>
    clean[0] ?? null;
  (document as unknown as { elementsFromPoint: unknown }).elementsFromPoint =
    () => clean.slice();
}

/** A minimal, always-successful fetch mock. */
export function mockFetch(
  resp: { status?: number; body?: unknown } = {},
): ReturnType<typeof vi.fn> {
  const { status = 200, body = null } = resp;
  const fn = vi.fn(async () => makeResponse(status, body));
  (globalThis as { fetch: unknown }).fetch = fn;
  return fn;
}

function makeResponse(status: number, body: unknown) {
  const text = body == null ? "" : JSON.stringify(body);
  return {
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
  };
}

/** Body of the most recent fetch POST, parsed as JSON. */
export function lastPostBody(fetchMock: ReturnType<typeof vi.fn>): any {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was never called");
  const init = call[1] as RequestInit | undefined;
  if (!init || typeof init.body !== "string") {
    throw new Error("fetch POST had no string body");
  }
  return JSON.parse(init.body);
}

// ---- shadow DOM access -----------------------------------------------------

export function getHost(): HTMLElement {
  const hosts = Array.from(
    document.body.querySelectorAll<HTMLElement>("*"),
  ).filter((el) => el.shadowRoot);
  const host = hosts[hosts.length - 1];
  if (!host) {
    throw new Error(
      "No shadow host found — widget did not mount, or its shadow root is closed. " +
        "These tests require an OPEN shadow root (attachShadow({mode:'open'})).",
    );
  }
  return host;
}

export function getShadow(): ShadowRoot {
  const sr = getHost().shadowRoot;
  if (!sr) throw new Error("Shadow root is closed; tests require mode:'open'.");
  return sr;
}

export function trigger(): HTMLElement {
  const el = getShadow().querySelector<HTMLElement>(
    '[aria-label="Give feedback"]',
  );
  if (!el) throw new Error("Trigger button not found in shadow root");
  return el;
}

export function dialog(): HTMLElement | null {
  // The COMPOSER dialog specifically — the thread popover is also
  // role="dialog", so match on the contract-defined accessible name.
  return getShadow().querySelector<HTMLElement>(
    '[role="dialog"][aria-label="Leave a comment"]',
  );
}

// ---- interaction -----------------------------------------------------------

export function enterCommentMode(): void {
  trigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/**
 * Simulate a click at document/viewport coords inside the capture layer.
 * We don't know which shadow node owns the click listener, so we dispatch a
 * bubbling click at each candidate node until the composer dialog appears.
 */
export function clickPoint(clientX: number, clientY: number): void {
  const shadow = getShadow();
  if (dialog()) return;
  // Prefer the capture layer: with persistent pins, earlier-rendered pin
  // buttons would otherwise swallow the click and open a thread popover.
  const cap = shadow.querySelector<HTMLElement>(".capture");
  const candidates = [
    ...(cap ? [cap] : []),
    ...Array.from(shadow.querySelectorAll<HTMLElement>("*")),
  ];
  for (const el of candidates) {
    const ev = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
    });
    // pageX/pageY are read-only on the event; some impls read them, so define.
    defineValue(ev, "pageX", clientX + window.scrollX);
    defineValue(ev, "pageY", clientY + window.scrollY);
    el.dispatchEvent(ev);
    if (dialog()) return;
  }
  if (!dialog()) {
    throw new Error(
      "Composer dialog did not open after clicking the capture layer",
    );
  }
}

export function fillComment(text: string, name?: string): void {
  const shadow = getShadow();
  const ta = shadow.querySelector<HTMLTextAreaElement>("textarea");
  if (!ta) throw new Error("Composer textarea not found");
  ta.value = text;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  if (name !== undefined) {
    const input = shadow.querySelector<HTMLInputElement>("input");
    if (input) {
      input.value = name;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
}

export function submit(): void {
  const shadow = getShadow();
  const btn = Array.from(
    shadow.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (b) => b.type === "submit" || /submit|send/i.test(b.textContent || ""),
  );
  if (!btn) throw new Error("Submit button not found");
  btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** Full flow: enter comment mode, click a point, type, submit; returns payload. */
export async function submitFeedback(args: {
  x: number;
  y: number;
  body?: string;
  name?: string;
  fetchMock: ReturnType<typeof vi.fn>;
}): Promise<any> {
  enterCommentMode();
  clickPoint(args.x, args.y);
  fillComment(args.body ?? "looks good to me", args.name);
  submit();
  await vi.waitFor(() => expect(args.fetchMock).toHaveBeenCalled());
  return lastPostBody(args.fetchMock);
}

// ---- crypto / misc ---------------------------------------------------------

/** Force crypto.randomUUID to return a known value (best effort). */
export function stubUUID(value = "11111111-1111-4111-8111-111111111111"): void {
  const c = globalThis.crypto as Crypto & { randomUUID?: () => string };
  try {
    vi.spyOn(c, "randomUUID").mockReturnValue(value as `${string}-${string}`);
  } catch {
    Object.defineProperty(c, "randomUUID", {
      configurable: true,
      value: () => value,
    });
  }
}

export function segmentCount(selector: string): number {
  return selector.split(/\s*[>+~]\s*|\s+/).filter(Boolean).length;
}

export function isUUID(s: unknown): boolean {
  return typeof s === "string" && UUID_RE.test(s);
}

/** Tear down widget + DOM + globals between tests. */
export async function cleanup(destroy?: () => void): Promise<void> {
  try {
    destroy?.();
  } catch {
    /* ignore */
  }
  document.body.innerHTML = "";
  document.head.querySelectorAll("style").forEach((s) => s.remove());
  // Widget storage (pins/draft/receipts) must never leak between tests.
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("tyrekick:")) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}

// ---- tiny internal utils ---------------------------------------------------

function defineGetter(obj: object, prop: string, get: () => number): void {
  Object.defineProperty(obj, prop, { configurable: true, get });
}
function defineValue(obj: object, prop: string, value: unknown): void {
  Object.defineProperty(obj, prop, {
    configurable: true,
    writable: true,
    value,
  });
}
