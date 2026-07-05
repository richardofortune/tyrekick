/**
 * Comment mode: a full-viewport transparent capture layer (crosshair) inside
 * the shadow root, a dismissible hint bar, and numbered pins. Handles mouse and
 * touch. Pins live in document space so they stay glued to content on scroll.
 *
 * Pins are first-class objects, not decorations: they render whenever any
 * exist (dimmed while the widget is idle, full strength when engaged), expose
 * a ~36px hit target, show their comment on hover/focus, and open the thread
 * popover on click. Scroll/resize tracking is owned HERE, tied to pin
 * visibility, so a visible pin can never freeze mid-viewport regardless of
 * which surface (drawer, composer, popover) is coming or going.
 */
import type { Overlay, Pin, Runtime } from "../index";
import { computeAnchor } from "../capture/anchor";
import { uuid } from "../capture/context";

const HINT_TEXT = "Click anywhere to leave a comment — Esc to cancel";
const HINT_TEXT_TOUCH = "Tap anywhere to leave a comment";
const TIP_MAX = 140;

function hintText(): string {
  try {
    if (typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches) {
      return HINT_TEXT_TOUCH;
    }
  } catch {
    /* fall through */
  }
  return HINT_TEXT;
}

export function createOverlay(rt: Runtime): Overlay {
  const root = rt.root;
  let active = false;
  let capture: HTMLElement | null = null;
  let hint: HTMLElement | null = null;
  /** Whether the window scroll/resize listeners are attached (pins visible). */
  let tracking = false;
  /** Reviewer pressed "Hide pins" in the drawer; comment mode overrides. */
  let hiddenByUser = false;
  let tip: HTMLElement | null = null;

  function pinLabel(p: Pin): string {
    if (p.status === "pending") return "Comment " + p.n + " (drafting)";
    const snippet = p.body ? ": " + p.body.slice(0, 60) : "";
    const closed = p.receipt
      ? p.receipt.status === "resolved"
        ? " (resolved)"
        : " (declined)"
      : "";
    return "Comment " + p.n + closed + snippet;
  }

  function makePinEl(p: Pin): void {
    const el = document.createElement("button");
    el.type = "button";
    el.className =
      "pin" + (p.status === "sent" ? " sent" : p.status === "failed" ? " failed" : "");
    el.setAttribute("aria-label", pinLabel(p));
    const span = document.createElement("span");
    span.textContent = String(p.n);
    el.appendChild(span);
    el.addEventListener("click", () => {
      if (p.status === "pending") return; // the composer is already its interface
      hideTip();
      rt.drawer.openThread(p);
    });
    el.addEventListener("mouseenter", () => showTip(p));
    el.addEventListener("mouseleave", hideTip);
    el.addEventListener("focus", () => showTip(p));
    el.addEventListener("blur", hideTip);
    p.el = el;
    root.appendChild(el);
  }

  function syncPinEl(p: Pin): void {
    if (!p.el) return;
    const s = p.el.querySelector("span");
    if (s) s.textContent = String(p.n);
    p.el.setAttribute("aria-label", pinLabel(p));
    p.el.classList.toggle("resolved", !!p.receipt && p.receipt.status === "resolved");
    p.el.classList.toggle("declined", !!p.receipt && p.receipt.status === "declined");
  }

  function renumberPins(): void {
    let n = 0;
    const roots = new Map<string, Pin>();
    for (const p of rt.pins) {
      if (p.replyToId !== null) continue;
      n += 1;
      p.n = n;
      roots.set(p.id, p);
      syncPinEl(p);
    }
    for (const p of rt.pins) {
      if (p.replyToId === null) continue;
      const rootPin = roots.get(p.replyToId);
      if (rootPin) {
        p.n = rootPin.n;
      } else {
        n += 1;
        p.n = n;
      }
    }
  }

  function layout(): void {
    const sx = window.scrollX;
    const sy = window.scrollY;
    for (const p of rt.pins) {
      if (!p.el) continue;
      p.el.style.left = p.docX - sx + "px";
      p.el.style.top = p.docY - sy + "px";
    }
  }

  /* ---- hover/focus tooltip: the comment text, right at the pin ---- */

  function showTip(p: Pin): void {
    if (!p.body || !p.el) return;
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "tip hidden";
      tip.setAttribute("role", "tooltip");
      root.appendChild(tip);
    }
    let text = p.body.length > TIP_MAX ? p.body.slice(0, TIP_MAX) + "…" : p.body;
    if (p.receipt) {
      const mark = p.receipt.status === "resolved" ? "✓ Resolved" : "✕ Declined";
      text += "\n" + mark + (p.receipt.note ? " — " + p.receipt.note : "");
    }
    tip.textContent = text;
    tip.classList.remove("hidden");
    const cx = p.docX - window.scrollX;
    const cy = p.docY - window.scrollY;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.min(Math.max(cx - w / 2, 8), window.innerWidth - w - 8);
    let top = cy - 18 - h - 8; // above the reticle
    if (top < 8) top = cy + 22; // flip below when clipped
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  function hideTip(): void {
    if (tip) tip.classList.add("hidden");
  }

  /* ---- visibility & tracking: pins own their own presence ---- */

  function onScroll(): void {
    hideTip(); // anchored to a viewport position that just changed
    layout();
  }

  function startTracking(): void {
    if (tracking) return;
    tracking = true;
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
  }

  function stopTracking(): void {
    if (!tracking) return;
    tracking = false;
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
  }

  function shouldShow(): boolean {
    if (!rt.pins.some((p) => p.replyToId === null)) return false;
    if (active) return true; // you must see existing pins to not duplicate them
    return !hiddenByUser;
  }

  function syncPins(): void {
    const show = shouldShow();
    for (const p of rt.pins) {
      if (p.replyToId !== null) continue; // replies have no page marker
      if (show) {
        if (!p.el || !p.el.isConnected) makePinEl(p);
        syncPinEl(p);
        p.el!.classList.remove("hidden");
      } else if (p.el) {
        p.el.classList.add("hidden");
      }
    }
    // Idle = no surface engaged; pins stay present but recede.
    const engaged =
      active ||
      (rt.drawer ? rt.drawer.isOpen() : false) ||
      (rt.panel ? rt.panel.isOpen() : false);
    rt.host.classList.toggle("tk-engaged", engaged);
    if (show) {
      startTracking();
      layout();
    } else {
      stopTracking();
      hideTip();
    }
  }

  function setPinsHidden(hidden: boolean): void {
    hiddenByUser = hidden;
    syncPins();
  }

  function pinsHidden(): boolean {
    return hiddenByUser;
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    if (rt.panel.isOpen()) return; // the composer owns Esc while it is open
    e.preventDefault();
    exit();
  }

  /**
   * Create a pending pin at document coords; "drop" runs the lock-on animation.
   * With `replyToId`, the pin is a marker-less reply linked to a root pin's
   * number and never renders on the page.
   */
  function addPin(
    docX: number,
    docY: number,
    anchor: Pin["anchor"],
    replyToId?: string | null,
  ): Pin {
    const parentId = typeof replyToId === "string" ? replyToId : null;
    const clientX = docX - window.scrollX;
    const clientY = docY - window.scrollY;
    // The anchor rect is the element's client box captured this same instant,
    // so the click's in-element fraction is exact; it lets the pin re-attach
    // to the element after reload/resize.
    const rect = parentId === null && anchor && anchor.element ? anchor.element.rect : null;
    const pin: Pin = {
      id: uuid(),
      n: rt.pins.filter((pp) => pp.replyToId === null).length + 1,
      docX,
      docY,
      clientX,
      clientY,
      status: "pending",
      replyToId: parentId,
      fx: rect && rect.w > 0 ? Math.min(Math.max((clientX - rect.x) / rect.w, 0), 1) : null,
      fy: rect && rect.h > 0 ? Math.min(Math.max((clientY - rect.y) / rect.h, 0), 1) : null,
      deliveredId: null,
      receipt: null,
      anchor,
      body: "",
      reviewer: null,
      at: "",
      el: null,
    };
    rt.pins.push(pin);
    renumberPins();
    if (parentId === null) {
      makePinEl(pin);
      syncPinEl(pin);
      pin.el!.classList.add("drop");
      syncPins();
    }
    return pin;
  }

  function pick(cx: number, cy: number): void {
    // A click while an untouched composer is open abandons that pin and
    // re-pins here; a composer with content keeps the click (capture is off).
    if (rt.panel.isOpen() && !rt.panel.abandonClean()) return;
    const anchor = computeAnchor(cx, cy, rt.host, capture);
    const pin = addPin(cx + window.scrollX, cy + window.scrollY, anchor);
    rt.panel.open(pin);
  }

  function onClick(e: MouseEvent): void {
    pick(e.clientX, e.clientY);
  }
  function onTouch(e: TouchEvent): void {
    const t = e.changedTouches[0];
    if (!t) return;
    e.preventDefault(); // suppress the emulated click that follows
    pick(t.clientX, t.clientY);
  }

  function captureOn(): void {
    if (capture) capture.classList.remove("hidden");
  }
  function captureOff(): void {
    if (capture) capture.classList.add("hidden");
  }

  function enter(): void {
    if (active) return;
    active = true;

    capture = document.createElement("div");
    capture.className = "capture";
    capture.addEventListener("click", onClick);
    capture.addEventListener("touchend", onTouch, { passive: false });

    hint = document.createElement("div");
    hint.className = "hint";
    const label = document.createElement("span");
    label.textContent = hintText();
    const done = document.createElement("button");
    done.type = "button";
    done.textContent = "Done";
    done.addEventListener("click", exit);
    hint.appendChild(label);
    hint.appendChild(done);

    root.appendChild(capture);
    root.appendChild(hint);
    syncPins();

    document.addEventListener("keydown", onKey, true);
    rt.trigger.classList.add("hidden");
    done.focus();
  }

  function exit(): void {
    if (!active) return;
    active = false;
    // Dismiss (not close): abandons a still-pending pin so it can't linger as a
    // hidden phantom, but keeps any typed draft for the next composer.
    if (rt.panel.isOpen()) rt.panel.dismiss(false);
    if (capture) {
      capture.remove();
      capture = null;
    }
    if (hint) {
      hint.remove();
      hint = null;
    }
    // Pins stay on the page — they are the reviewer's marks, not mode UI.
    syncPins();
    document.removeEventListener("keydown", onKey, true);
    rt.trigger.classList.remove("hidden");
    rt.trigger.focus();
  }

  function focus(): void {
    const b = hint ? hint.querySelector("button") : null;
    (b || rt.trigger).focus();
  }

  function removePin(p: Pin): void {
    const i = rt.pins.indexOf(p);
    if (i >= 0) rt.pins.splice(i, 1);
    if (p.el) p.el.remove();
    renumberPins();
    syncPins();
    if (rt.drawer) rt.drawer.refresh();
  }

  function isActive(): boolean {
    return active;
  }

  function destroy(): void {
    exit();
    stopTracking();
    for (const p of rt.pins) {
      if (p.el) p.el.remove();
      p.el = null;
    }
    if (tip) {
      tip.remove();
      tip = null;
    }
  }

  return {
    enter,
    exit,
    layout,
    captureOn,
    captureOff,
    addPin,
    removePin,
    syncPins,
    setPinsHidden,
    pinsHidden,
    isActive,
    focus,
    destroy,
  };
}
