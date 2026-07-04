/**
 * Public API + shared runtime. ESM entry (NO auto-init).
 *
 *   import { init, destroy } from "tyrekick";
 *
 * Everything the widget renders lives inside ONE shadow root on a single host
 * element appended to <body>. We never mutate host-page DOM or styles.
 */
import type { TyrekickConfig, FeedbackPayload, Position, Transport } from "./types";
import { styles } from "./ui/styles";
import { createTrigger } from "./ui/trigger";
import { createOverlay } from "./ui/overlay";
import { createPanel } from "./ui/panel";
import { createDrawer } from "./ui/drawer";
import { uuid } from "./capture/context";
import { startErrors, stopErrors } from "./capture/errors";

export interface Resolved {
  webhook: string;
  appVersion: string;
  projectName: string;
  position: Position;
  accent: string;
  theme: "auto" | "light" | "dark";
  branding: boolean;
  fieldName: boolean;
  transport: Transport;
  persist: boolean;
  captureErrors: boolean;
}

export interface Pin {
  /** Stable identity for this comment/pin, regardless of UI reordering. */
  id: string;
  /** User-facing display number for top-level pins; replies derive from roots. */
  n: number;
  /** document-space coordinates (survive scroll) */
  docX: number;
  docY: number;
  /** viewport coordinates at creation (used to place the composer) */
  clientX: number;
  clientY: number;
  status: "pending" | "sent" | "failed";
  /** Root pin id this comment replies to, or null for a top-level comment. */
  replyToId: string | null;
  /**
   * Click position as a fraction of the anchored element's box (0..1), or null
   * when there is no element anchor. Lets pins re-attach to their element after
   * reload/resize instead of trusting stale document coordinates.
   */
  fx: number | null;
  fy: number | null;
  anchor: FeedbackPayload["anchor"];
  /** comment text as submitted (empty while pending) */
  body: string;
  reviewer: string | null;
  /** ISO timestamp of submission ("" while pending) */
  at: string;
  el: HTMLElement | null;
}

export interface Overlay {
  enter(): void;
  exit(): void;
  layout(): void;
  captureOn(): void;
  captureOff(): void;
  /** Create a pending pin; pass `replyToId` (a root pin's stable id) for a
   *  marker-less reply (used by drawer follow-ups). */
  addPin(docX: number, docY: number, anchor: Pin["anchor"], replyToId?: string | null): Pin;
  removePin(p: Pin): void;
  showPins(): void;
  hidePins(): void;
  isActive(): boolean;
  focus(): void;
  destroy(): void;
}

export interface Drawer {
  open(): void;
  close(): void;
  isOpen(): boolean;
  refresh(): void;
  destroy(): void;
}

export interface Panel {
  open(p: Pin, prefill?: string): void;
  close(restoreFocus: boolean): void;
  isOpen(): boolean;
  /** If the composer is open but untouched, discard its pending pin and close; returns whether it did. */
  abandonClean(): boolean;
  /** Close like Esc: abandon a pending pin but KEEP the saved draft text. */
  dismiss(restoreFocus: boolean): void;
  destroy(): void;
}

export interface Draft {
  body: string;
  name: string;
}

export interface Runtime {
  cfg: Resolved;
  root: ShadowRoot;
  host: HTMLElement;
  sessionId: string;
  pins: Pin[];
  overlay: Overlay;
  panel: Panel;
  drawer: Drawer;
  trigger: HTMLButtonElement;
  pendingDraft: Draft | null;
  savePins(): void;
  saveDraft(d: Draft): void;
  clearDraft(): void;
}

let rt: Runtime | null = null;
let resizeCb: (() => void) | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-derive each root pin's document position from its anchored element's
 * CURRENT box and the stored click fraction. Pins whose selector no longer
 * resolves (or that predate fx/fy) keep their raw coordinates.
 */
function reprojectPins(): void {
  if (!rt) return;
  for (const p of rt.pins) {
    if (p.replyToId !== null) continue; // replies have no page position of their own
    if (p.fx === null || p.fy === null || !p.anchor || !p.anchor.selector) continue;
    let el: Element | null = null;
    try {
      el = document.querySelector(p.anchor.selector);
    } catch {
      continue; // selector invalid in this DOM — keep stored coords
    }
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue; // display:none or detached layout
    p.docX = window.scrollX + r.left + p.fx * r.width;
    p.docY = window.scrollY + r.top + p.fy * r.height;
  }
  rt.overlay.layout();
}

/* ---- theme (tk-light / tk-dark host class; "auto" tracks the OS live) ---- */

let themeMq: MediaQueryList | null = null;
let themeCb: ((e: MediaQueryListEvent) => void) | null = null;

function setThemeClass(host: HTMLElement, dark: boolean): void {
  host.classList.toggle("tk-dark", dark);
  host.classList.toggle("tk-light", !dark);
}

function startTheme(host: HTMLElement, theme: Resolved["theme"]): void {
  if (theme === "auto" && typeof window.matchMedia === "function") {
    try {
      themeMq = window.matchMedia("(prefers-color-scheme: dark)");
      themeCb = (e: MediaQueryListEvent) => setThemeClass(host, e.matches);
      themeMq.addEventListener("change", themeCb);
      setThemeClass(host, themeMq.matches);
      return;
    } catch {
      /* fall through to light */
    }
  }
  setThemeClass(host, theme === "dark");
}

function stopTheme(): void {
  if (themeMq && themeCb) {
    try {
      themeMq.removeEventListener("change", themeCb);
    } catch {
      /* ignore */
    }
  }
  themeMq = null;
  themeCb = null;
}

export function init(config: TyrekickConfig): void {
  if (rt) {
    console.warn("[Tyrekick] already initialised — call destroy() first.");
    return;
  }
  if (!config || !config.webhook) {
    throw new Error("[Tyrekick] init: `webhook` is required.");
  }
  if (!config.appVersion) {
    throw new Error("[Tyrekick] init: `appVersion` is required.");
  }

  const cfg: Resolved = {
    webhook: config.webhook,
    appVersion: config.appVersion,
    projectName: config.projectName || document.title || "Prototype",
    position: config.position === "bottom-left" ? "bottom-left" : "bottom-right",
    accent: config.accent || "#FFC53D",
    theme: config.theme === "light" || config.theme === "dark" ? config.theme : "auto",
    branding: config.branding !== false,
    fieldName: !config.fields || config.fields.name !== false,
    transport: config.transport === "discord" ? "discord" : "json",
    persist: config.persist !== false,
    captureErrors: config.captureErrors !== false,
  };

  const host = document.createElement("div");
  host.setAttribute("data-tyrekick", "");
  host.style.cssText = "position:absolute;top:0;left:0;width:0;height:0";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = styles(cfg.accent);
  root.appendChild(style);
  startTheme(host, cfg.theme);

  rt = {
    cfg,
    root,
    host,
    sessionId: uuid(),
    pins: [],
    overlay: null as unknown as Overlay,
    panel: null as unknown as Panel,
    drawer: null as unknown as Drawer,
    trigger: null as unknown as HTMLButtonElement,
    pendingDraft: null,
    savePins,
    saveDraft,
    clearDraft,
  };

  rt.overlay = createOverlay(rt);
  rt.panel = createPanel(rt);
  rt.trigger = createTrigger(rt);
  root.appendChild(rt.trigger);
  rt.drawer = createDrawer(rt);

  (document.body || document.documentElement).appendChild(host);

  startErrors(cfg.captureErrors);

  if (cfg.persist) restore();
  rt.drawer.refresh();

  // Pins re-attach to their anchored element (selector + in-element fraction)
  // so they survive viewport/layout changes; raw doc coords are the fallback.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", reprojectPins, { once: true });
  } else {
    reprojectPins();
  }
  resizeCb = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(reprojectPins, 150);
  };
  window.addEventListener("resize", resizeCb);
}

export function destroy(): void {
  if (!rt) return;
  stopTheme();
  if (resizeCb) {
    window.removeEventListener("resize", resizeCb);
    resizeCb = null;
  }
  if (resizeTimer) {
    clearTimeout(resizeTimer);
    resizeTimer = null;
  }
  try {
    stopErrors();
  } catch {
    /* ignore */
  }
  try {
    rt.drawer.destroy();
  } catch {
    /* ignore */
  }
  try {
    rt.panel.destroy();
  } catch {
    /* ignore */
  }
  try {
    rt.overlay.destroy();
  } catch {
    /* ignore */
  }
  try {
    rt.host.remove();
  } catch {
    /* ignore */
  }
  rt = null;
}

/* ---- session persistence (localStorage, gated by cfg.persist) ---- */

function pinsKey(): string {
  return "tyrekick:pins:" + location.pathname;
}
function draftKey(): string {
  return "tyrekick:draft:" + location.pathname;
}

function savePins(): void {
  if (!rt || !rt.cfg.persist) return;
  try {
    const data = rt.pins
      // localStorage is only for unsent work that may need recovery after a reload.
      .filter((p) => p.status === "failed")
      .map((p) => ({
        i: p.id,
        n: p.n,
        x: p.docX,
        y: p.docY,
        s: p.status,
        a: p.anchor,
        b: p.body,
        r: p.reviewer,
        t: p.at,
        ri: p.replyToId,
        ex: p.fx,
        ey: p.fy,
      }));
    if (data.length) {
      localStorage.setItem(pinsKey(), JSON.stringify(data));
    } else {
      localStorage.removeItem(pinsKey());
    }
  } catch {
    /* storage unavailable/full — non-fatal */
  }
}

function saveDraft(d: Draft): void {
  if (!rt) return;
  rt.pendingDraft = d;
  if (!rt.cfg.persist) return;
  try {
    localStorage.setItem(draftKey(), JSON.stringify(d));
  } catch {
    /* ignore */
  }
}

function clearDraft(): void {
  if (!rt) return;
  rt.pendingDraft = null;
  if (!rt.cfg.persist) return;
  try {
    localStorage.removeItem(draftKey());
  } catch {
    /* ignore */
  }
}

function restore(): void {
  if (!rt) return;
  try {
    const raw = localStorage.getItem(pinsKey());
    if (raw) {
      const arr = JSON.parse(raw) as Array<{
        i?: string;
        n: number;
        x: number;
        y: number;
        s: Pin["status"];
        a: Pin["anchor"];
        b?: string;
        r?: string | null;
        t?: string;
        ri?: string | null;
        re?: number | null;
        ex?: number | null;
        ey?: number | null;
      }>;
      if (Array.isArray(arr)) {
        const idsByLegacyNumber = new Map<number, string>();
        const restored = arr
          .filter((d) => d && d.s === "failed")
          .map((d) => {
            const id = typeof d.i === "string" ? d.i : uuid();
            idsByLegacyNumber.set(d.n, id);
            return { d, id, body: typeof d.b === "string" ? d.b : "" };
          });
        for (const { d, id, body } of restored) {
          const legacyRootNumber =
            typeof d.re === "number" ? d.re : legacyReplyTo(body, d.n);
          rt.pins.push({
            id,
            n: d.n,
            docX: d.x,
            docY: d.y,
            clientX: 0,
            clientY: 0,
            status: "failed",
            replyToId:
              typeof d.ri === "string"
                ? d.ri
                : legacyRootNumber !== null
                  ? (idsByLegacyNumber.get(legacyRootNumber) ?? null)
                  : null,
            fx: typeof d.ex === "number" ? d.ex : null,
            fy: typeof d.ey === "number" ? d.ey : null,
            anchor: upgradeAnchor(d.a),
            body,
            reviewer: typeof d.r === "string" ? d.r : null,
            at: typeof d.t === "string" ? d.t : "",
            el: null,
          });
        }
        normalizeRestoredPins(rt.pins);
      }
    }
  } catch {
    /* ignore corrupt data */
  }
  try {
    const raw = localStorage.getItem(draftKey());
    if (raw) rt.pendingDraft = JSON.parse(raw) as Draft;
  } catch {
    /* ignore */
  }
}

/**
 * Follow-ups saved by builds that predate Pin.replyToId were full pins whose
 * only linkage was the "Re #N:" body prefix — recover it from there.
 */
function legacyReplyTo(body: string, n: number): number | null {
  const m = /^Re #(\d+):/.exec(body);
  const pn = m ? parseInt(m[1], 10) : NaN;
  return Number.isInteger(pn) && pn < n ? pn : null;
}

function normalizeRestoredPins(pins: Pin[]): void {
  let n = 0;
  const roots = new Map<string, Pin>();
  for (const p of pins) {
    if (p.replyToId !== null) continue;
    n += 1;
    p.n = n;
    roots.set(p.id, p);
  }
  for (const p of pins) {
    if (p.replyToId === null) continue;
    const root = roots.get(p.replyToId);
    if (root) {
      p.n = root.n;
    } else {
      n += 1;
      p.n = n;
    }
  }
}

/**
 * Pins persisted by a schema-v1 build lack anchor.element / anchor.context.
 * Backfill them so payload construction never breaks after an upgrade.
 */
function upgradeAnchor(a: Pin["anchor"] | undefined): Pin["anchor"] {
  const p = (a || {}) as Partial<Pin["anchor"]>;
  return {
    x_pct: typeof p.x_pct === "number" ? p.x_pct : 0,
    y_pct: typeof p.y_pct === "number" ? p.y_pct : 0,
    selector: typeof p.selector === "string" ? p.selector : null,
    viewport: p.viewport || { w: 0, h: 0 },
    element: p.element || null,
    context: p.context || { heading: null, landmark: null },
  };
}
