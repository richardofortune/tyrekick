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
  /** Shared-review key, or null when each reviewer sees only their own pins. */
  reviewKey: string | null;
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
  /**
   * The payload id of the DELIVERED comment (uuid; differs from Pin.id — a new
   * payload id is minted per send attempt). It is the capability used to look
   * up fix-status on the worker's /receipts route. Null until a send succeeds;
   * meaningless on the Discord transport (write-only, no read-back).
   */
  deliveredId: string | null;
  /** Closure state pulled back from the worker, or null while open/unknown. */
  receipt: { status: "resolved" | "declined"; note: string | null; at: string | null } | null;
  /**
   * A one-sentence AI acknowledgement of this comment, pulled back from the
   * worker's /receipts route, or null while none. Runtime-only exactly like
   * `receipt`: fetched every load, NEVER persisted to localStorage. It is a
   * thread message, not a status change — it never touches `receipt` or the
   * pin's open/closed state.
   */
  aiReply: string | null;
  /**
   * True when this pin is SOMEONE ELSE's comment, pulled from the worker's
   * /shared view (reviewKey set). Foreign pins are strictly read-only: they
   * are never persisted to localStorage, never retried or discarded, and never
   * counted as this reviewer's unsent work. They exist so a reviewer can see
   * what has already been said before saying it again.
   */
  foreign: boolean;
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
  /**
   * Reconcile pin presentation with runtime state: pins render whenever any
   * exist (unless the reviewer hid them), dimmed when the widget is idle, with
   * scroll/resize tracking owned here so visible pins can never drift.
   */
  syncPins(): void;
  /** Reviewer's "hide pins" preference (drawer eye toggle); comment mode overrides it. */
  setPinsHidden(hidden: boolean): void;
  pinsHidden(): boolean;
  isActive(): boolean;
  focus(): void;
  destroy(): void;
}

export interface Drawer {
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** Open the thread popover for a pin's comment, anchored at the pin. */
  openThread(p: Pin): void;
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
  /** Persist delivered-comment receipts (worker transport only, persist-gated). */
  saveReceipts(): void;
  /** Ask the worker for fix-status on restored delivered comments (throttled, silent). */
  checkReceipts(): void;
  /**
   * Pull every reviewer's pins from the worker's /shared view (silent, and
   * throttled unless `force` — see SHARED_POLL_MIN_MS).
   */
  fetchShared(force?: boolean): void;
}

let rt: Runtime | null = null;
let resizeCb: (() => void) | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
/** Delivered ids restored from the receipts store — the set worth polling. */
const receiptWatch = new Set<string>();
let lastReceiptCheck = 0;

/* ---- SPA navigation: state is keyed by pathname, so it must follow the route ---- */
type HistoryFn = (data: unknown, unused: string, url?: string | URL | null) => void;
/** The pathname whose pins are currently loaded; state resets when it changes. */
let lastPath = "";
let popCb: (() => void) | null = null;
let origPushState: HistoryFn | null = null;
let origReplaceState: HistoryFn | null = null;

/** How long a delivered-comment receipt stays worth restoring/polling. */
const RECEIPT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const RECEIPT_MAX_COUNT = 50;
const RECEIPT_POLL_MIN_MS = 60_000;

/**
 * Shared-view poll throttle for BACKGROUND refreshes (init, route change).
 * A user-initiated refresh (opening the drawer) ignores this and is instead
 * guarded by `sharedInFlight` — asking to see the overview is an explicit
 * request for what is there now, and a 60s floor would make the first open
 * after page load, the very moment the question is asked, always stale.
 */
const SHARED_POLL_MIN_MS = 60_000;
let lastSharedFetch = 0;
/** One shared request at a time: makes click-spamming the drawer harmless. */
let sharedInFlight = false;

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

/**
 * Client-side navigation (SPA) changes location.pathname without a reload, so
 * the once-at-init restore() never re-runs and a route's pins would otherwise
 * linger over the next view. On a real pathname change we reset per-route state
 * — tear down the current pins, reload storage under the new key, and reproject
 * once the new route has painted. Query/hash-only changes are ignored because
 * storage is keyed by pathname alone.
 */
function resetRoute(): void {
  if (!rt) return;
  // Drop any in-flight composing/reading surfaces from the previous route.
  if (rt.panel.isOpen()) rt.panel.dismiss(false);
  if (rt.drawer.isOpen()) rt.drawer.close();
  // Tear down the previous route's pins (elements + in-memory list).
  for (const p of rt.pins) {
    if (p.el) p.el.remove();
    p.el = null;
  }
  rt.pins.length = 0;
  rt.pendingDraft = null;
  receiptWatch.clear();
  lastReceiptCheck = 0;
  // The shared view is per-route, so the new route must be free to fetch
  // immediately rather than waiting out the previous route's throttle.
  lastSharedFetch = 0;
  // Reload state for the route we've arrived at.
  if (rt.cfg.persist) restore();
  rt.overlay.syncPins();
  rt.drawer.refresh();
  checkReceipts();
  fetchShared();
  // The framework may not have painted the new DOM yet; reproject now (raw
  // coords are the fallback) and again next frame once selectors can resolve.
  reprojectPins();
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => reprojectPins());
  }
}

/** Fire on any navigation; only a genuine pathname change triggers a reset. */
function onNavigate(): void {
  if (!rt) return;
  if (location.pathname === lastPath) return;
  lastPath = location.pathname;
  resetRoute();
}

function startNav(): void {
  popCb = onNavigate;
  window.addEventListener("popstate", popCb); // browser back/forward
  // pushState/replaceState don't emit an event — wrap them (reverted in destroy).
  try {
    const wrap = (orig: HistoryFn): HistoryFn =>
      function (this: History, data: unknown, unused: string, url?: string | URL | null) {
        const r = orig.call(this, data, unused, url);
        // Defer so the router can update the DOM before we reset/reproject.
        queueMicrotask(onNavigate);
        return r;
      };
    origPushState = history.pushState.bind(history) as HistoryFn;
    origReplaceState = history.replaceState.bind(history) as HistoryFn;
    history.pushState = wrap(origPushState) as History["pushState"];
    history.replaceState = wrap(origReplaceState) as History["replaceState"];
  } catch {
    /* history unavailable — popstate still covers back/forward */
  }
}

function stopNav(): void {
  if (popCb) {
    window.removeEventListener("popstate", popCb);
    popCb = null;
  }
  try {
    if (origPushState) history.pushState = origPushState as History["pushState"];
    if (origReplaceState) history.replaceState = origReplaceState as History["replaceState"];
  } catch {
    /* ignore */
  }
  origPushState = null;
  origReplaceState = null;
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
    reviewKey: typeof config.reviewKey === "string" && config.reviewKey ? config.reviewKey : null,
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
    saveReceipts,
    checkReceipts,
    fetchShared,
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
  checkReceipts();
  fetchShared();

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

  // Follow SPA route changes so per-route pins don't leak across views.
  lastPath = location.pathname;
  startNav();
}

export function destroy(): void {
  if (!rt) return;
  stopTheme();
  stopNav();
  lastPath = "";
  if (resizeCb) {
    window.removeEventListener("resize", resizeCb);
    resizeCb = null;
  }
  if (resizeTimer) {
    clearTimeout(resizeTimer);
    resizeTimer = null;
  }
  receiptWatch.clear();
  lastReceiptCheck = 0;
  lastSharedFetch = 0;
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
function receiptsKey(): string {
  return "tyrekick:receipts:" + location.pathname;
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

/**
 * Persist delivered-comment receipts so a returning reviewer's pins can show
 * what happened to them. Worker transport only (Discord has no read-back) and
 * persist-gated like all storage. Newest-first, capped in count and age.
 */
function saveReceipts(): void {
  if (!rt || !rt.cfg.persist || rt.cfg.transport !== "json") return;
  try {
    const cutoff = Date.now() - RECEIPT_MAX_AGE_MS;
    const data = rt.pins
      // `!p.foreign` is load-bearing: other reviewers' pins live on the server
      // and are re-fetched every load. Persisting them here would resurrect
      // them locally as this reviewer's own comments — and keep resurrecting
      // them after they were declined and withdrawn from the shared view.
      .filter((p) => !p.foreign && p.deliveredId !== null && p.status === "sent")
      .filter((p) => {
        const ts = Date.parse(p.at);
        return !Number.isFinite(ts) || ts >= cutoff;
      })
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, RECEIPT_MAX_COUNT)
      .map((p) => ({
        d: p.deliveredId,
        i: p.id,
        n: p.n,
        x: p.docX,
        y: p.docY,
        a: p.anchor,
        b: p.body,
        r: p.reviewer,
        t: p.at,
        ri: p.replyToId,
        ex: p.fx,
        ey: p.fy,
      }));
    if (data.length) {
      localStorage.setItem(receiptsKey(), JSON.stringify(data));
    } else {
      localStorage.removeItem(receiptsKey());
    }
  } catch {
    /* storage unavailable/full — non-fatal */
  }
}

function restoreReceipts(): void {
  if (!rt) return;
  try {
    const raw = localStorage.getItem(receiptsKey());
    if (!raw) return;
    const arr = JSON.parse(raw) as Array<{
      d?: string;
      i?: string;
      n?: number;
      x?: number;
      y?: number;
      a?: Pin["anchor"];
      b?: string;
      r?: string | null;
      t?: string;
      ri?: string | null;
      ex?: number | null;
      ey?: number | null;
    }>;
    if (!Array.isArray(arr)) return;
    const cutoff = Date.now() - RECEIPT_MAX_AGE_MS;
    for (const d of arr) {
      if (!d || typeof d.d !== "string") continue;
      const ts = Date.parse(d.t || "");
      if (Number.isFinite(ts) && ts < cutoff) continue;
      receiptWatch.add(d.d);
      rt.pins.push({
        id: typeof d.i === "string" ? d.i : uuid(),
        n: typeof d.n === "number" ? d.n : 0,
        docX: typeof d.x === "number" ? d.x : 0,
        docY: typeof d.y === "number" ? d.y : 0,
        clientX: 0,
        clientY: 0,
        status: "sent",
        replyToId: typeof d.ri === "string" ? d.ri : null,
        fx: typeof d.ex === "number" ? d.ex : null,
        fy: typeof d.ey === "number" ? d.ey : null,
        deliveredId: d.d,
        receipt: null,
        aiReply: null,
        foreign: false,
        anchor: upgradeAnchor(d.a),
        body: typeof d.b === "string" ? d.b : "",
        reviewer: typeof d.r === "string" ? d.r : null,
        at: typeof d.t === "string" ? d.t : "",
        el: null,
      });
    }
  } catch {
    /* ignore corrupt data */
  }
}

/**
 * Ask the worker what happened to restored delivered comments (the /receipts
 * capability route). Fire-and-forget, throttled, and silent on every failure —
 * a destination without the route simply never turns pins green.
 */
function checkReceipts(): void {
  if (!rt || rt.cfg.transport !== "json") return;
  const now = Date.now();
  if (now - lastReceiptCheck < RECEIPT_POLL_MIN_MS) return;
  const ids = rt.pins
    .map((p) => p.deliveredId)
    .filter((id): id is string => id !== null && receiptWatch.has(id))
    .slice(0, RECEIPT_MAX_COUNT);
  if (!ids.length) return;
  lastReceiptCheck = now;
  const base = rt.cfg.webhook.replace(/\/feedback\/?$/, "");
  void fetch(base + "/receipts?ids=" + ids.join(","))
    .then((res) => (res && res.ok ? res.json() : null))
    .then((data: unknown) => {
      const body = data as { ok?: unknown; receipts?: unknown } | null;
      if (!rt || !body || body.ok !== true || !Array.isArray(body.receipts)) return;
      let changed = false;
      for (const r of body.receipts as Array<{
        id?: unknown;
        status?: unknown;
        resolved_at?: unknown;
        resolution_note?: unknown;
        ai_reply?: unknown;
      }>) {
        if (!r || typeof r.id !== "string") continue;
        const pin = rt.pins.find((p) => p.deliveredId === r.id);
        if (!pin) continue;
        // AI acknowledgement is a THREAD MESSAGE, not a status change: apply it
        // whatever the status ("open" included) and never let it touch
        // pin.receipt or the pin's open/closed state.
        const aiReply = typeof r.ai_reply === "string" ? r.ai_reply : null;
        if (pin.aiReply !== aiReply) {
          pin.aiReply = aiReply;
          changed = true;
        }
        if (r.status !== "resolved" && r.status !== "declined") continue;
        const note = typeof r.resolution_note === "string" ? r.resolution_note : null;
        const at = typeof r.resolved_at === "string" ? r.resolved_at : null;
        if (pin.receipt && pin.receipt.status === r.status && pin.receipt.note === note) continue;
        pin.receipt = { status: r.status, note, at };
        changed = true;
      }
      if (changed && rt.drawer) rt.drawer.refresh(); // refresh also re-syncs pins
    })
    .catch(() => {
      /* silent by contract — never a console error */
    });
}

/* ---- shared review (other reviewers' pins; opt-in via cfg.reviewKey) ---- */

/** One pin as the worker's /shared projection sends it. All fields optional
 *  on the wire — an older or hand-rolled destination may send less. */
interface SharedPin {
  id?: unknown;
  created_at?: unknown;
  body?: unknown;
  reviewer_name?: unknown;
  status?: unknown;
  resolution_note?: unknown;
  resolved_at?: unknown;
  anchor?: unknown;
}

/**
 * Order pins so every reviewer numbers them the same way: delivered comments
 * chronologically by submission time, then this browser's unsent work (which
 * has no submission time yet and exists only here) in its own order.
 *
 * Only ever called in shared mode. Single-reviewer numbering keeps its historic
 * insertion order so existing installs renumber nothing on upgrade.
 */
function sortPinsChronologically(pins: Pin[]): void {
  const order = new Map<Pin, number>();
  pins.forEach((p, i) => order.set(p, i));
  pins.sort((a, b) => {
    const at = a.at || "";
    const bt = b.at || "";
    // Unsent work (no timestamp) always sorts after everything delivered.
    if (!at && bt) return 1;
    if (at && !bt) return -1;
    if (at !== bt) return at < bt ? -1 : 1;
    // Same timestamp (or both unsent): keep the order we already had, so
    // numbering never flickers between polls.
    return (order.get(a) ?? 0) - (order.get(b) ?? 0);
  });
}

/**
 * Fold the worker's shared view into the pin list.
 *
 * Rules that keep this safe:
 *  - A shared pin that matches one of OUR delivered ids is skipped — your own
 *    comment must not come back as a second, foreign copy of itself.
 *  - Existing foreign pins are updated in place (status/note), never duplicated.
 *  - Foreign pins that vanish from the view (declined, or aged past the cap)
 *    are dropped, so declining spam removes it from everyone's page.
 */
function mergeShared(list: SharedPin[]): boolean {
  if (!rt) return false;
  const mine = new Set(
    rt.pins.filter((p) => !p.foreign && p.deliveredId).map((p) => p.deliveredId as string),
  );
  const seen = new Set<string>();
  let changed = false;

  for (const s of list) {
    if (!s || typeof s.id !== "string") continue;
    if (mine.has(s.id)) continue; // our own comment, already on the page
    const status = s.status;
    // "declined" never reaches us (the worker withholds it), but an older
    // worker might send it — treat it the same way and skip.
    if (status === "declined") continue;
    seen.add(s.id);

    const body = typeof s.body === "string" ? s.body : "";
    if (!body) continue;
    const note = typeof s.resolution_note === "string" ? s.resolution_note : null;
    const at = typeof s.created_at === "string" ? s.created_at : "";
    const receipt: Pin["receipt"] =
      status === "resolved"
        ? {
            status: "resolved",
            note,
            at: typeof s.resolved_at === "string" ? s.resolved_at : null,
          }
        : null;

    const existing = rt.pins.find((p) => p.foreign && p.deliveredId === s.id);
    if (existing) {
      const sameReceipt =
        (existing.receipt === null && receipt === null) ||
        (existing.receipt !== null &&
          receipt !== null &&
          existing.receipt.status === receipt.status &&
          existing.receipt.note === receipt.note);
      if (!sameReceipt) {
        existing.receipt = receipt;
        changed = true;
      }
      continue;
    }

    const anchor = upgradeAnchor(s.anchor as Pin["anchor"] | undefined);
    // Place it from the document percentages the other reviewer recorded. When
    // their click also carried a selector we hand reprojectPins a centre
    // fraction, so the pin re-anchors to the live element like a local one —
    // the exact in-element offset isn't recoverable (it is not in the payload),
    // and the element's centre is both stable and honest about that.
    const doc = document.documentElement;
    const docW = doc ? doc.scrollWidth : 0;
    const docH = doc ? doc.scrollHeight : 0;
    rt.pins.push({
      // The server id doubles as the local pin id (both are UUIDs, so they
      // cannot collide). That makes a foreign pin's identity stable across
      // reloads, which is what lets a local reply stay attached to the comment
      // it was answering instead of orphaning into a root.
      id: s.id,
      n: 0, // assigned by the renumber pass below
      docX: (Number(anchor.x_pct) / 100) * docW,
      docY: (Number(anchor.y_pct) / 100) * docH,
      clientX: 0,
      clientY: 0,
      status: "sent",
      replyToId: null, // threads are per-destination; a foreign pin is a root
      fx: anchor.selector ? 0.5 : null,
      fy: anchor.selector ? 0.5 : null,
      deliveredId: s.id,
      receipt,
      aiReply: null,
      foreign: true,
      anchor,
      body,
      reviewer: typeof s.reviewer_name === "string" ? s.reviewer_name : null,
      at,
      el: null,
    });
    changed = true;
  }

  // Drop foreign pins the view no longer returns (declined or aged out).
  for (let i = rt.pins.length - 1; i >= 0; i -= 1) {
    const p = rt.pins[i];
    if (!p.foreign) continue;
    if (p.deliveredId && seen.has(p.deliveredId)) continue;
    if (p.el) p.el.remove();
    rt.pins.splice(i, 1);
    changed = true;
  }

  if (changed) {
    sortPinsChronologically(rt.pins);
    normalizeRestoredPins(rt.pins);
  }
  return changed;
}

/**
 * Ask the worker for every reviewer's pins on this project + route. Same
 * posture as checkReceipts: throttled, fire-and-forget, and silent on every
 * failure — a destination without /shared (or with the feature switched off)
 * simply never shows foreign pins, with no console noise ever.
 */
function fetchShared(force?: boolean): void {
  if (!rt || !rt.cfg.reviewKey || rt.cfg.transport !== "json") return;
  if (sharedInFlight) return;
  const now = Date.now();
  if (!force && now - lastSharedFetch < SHARED_POLL_MIN_MS) return;
  lastSharedFetch = now;
  sharedInFlight = true;
  const base = rt.cfg.webhook.replace(/\/feedback\/?$/, "");
  // Scope by PATHNAME, not the full route: pins are per-pathname everywhere
  // else in the widget (storage keys, SPA reset), and reviewers reach the same
  // page by links that differ only in query string (?utm_source=…, ?ref=…).
  // Sending the full route would silently split one conversation into several.
  // It also keeps the page's own query string — which can carry link secrets —
  // out of the request.
  const qs =
    "?project=" +
    encodeURIComponent(rt.cfg.projectName) +
    "&route=" +
    encodeURIComponent(location.pathname);
  void fetch(base + "/shared" + qs, {
    headers: { "X-Tyrekick-Review-Key": rt.cfg.reviewKey },
  })
    .then((res) => (res && res.ok ? res.json() : null))
    .then((data: unknown) => {
      const body = data as { ok?: unknown; pins?: unknown } | null;
      if (!rt || !body || body.ok !== true || !Array.isArray(body.pins)) return;
      if (mergeShared(body.pins as SharedPin[])) {
        rt.drawer.refresh(); // refresh also re-syncs pins
        reprojectPins(); // foreign pins arrive with no coords — place them now
      }
    })
    .catch(() => {
      /* silent by contract — never a console error */
    })
    .then(() => {
      sharedInFlight = false;
    });
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
  // Delivered comments first (chronologically they came first), then unsent
  // work; a single renumber pass at the end covers both.
  restoreReceipts();
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
            deliveredId: null,
            receipt: null,
            aiReply: null,
            foreign: false,
            anchor: upgradeAnchor(d.a),
            body,
            reviewer: typeof d.r === "string" ? d.r : null,
            at: typeof d.t === "string" ? d.t : "",
            el: null,
          });
        }
      }
    }
  } catch {
    /* ignore corrupt data */
  }
  normalizeRestoredPins(rt.pins);
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
