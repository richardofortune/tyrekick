/**
 * Comment mode: a full-viewport transparent capture layer (crosshair) inside
 * the shadow root, a dismissible hint bar, and numbered pins. Handles mouse and
 * touch. Pins live in document space so they stay glued to content on scroll.
 */
import type { Overlay, Pin, Runtime } from "../index";
import { computeAnchor } from "../capture/anchor";

const HINT_TEXT = "Click anywhere to leave a comment — Esc to cancel";

export function createOverlay(rt: Runtime): Overlay {
  const root = rt.root;
  let active = false;
  let capture: HTMLElement | null = null;
  let hint: HTMLElement | null = null;

  function makePinEl(p: Pin): void {
    const el = document.createElement("div");
    el.className =
      "pin" + (p.status === "sent" ? " sent" : p.status === "failed" ? " failed" : "");
    const span = document.createElement("span");
    span.textContent = String(p.n);
    el.appendChild(span);
    p.el = el;
    root.appendChild(el);
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

  function showPins(): void {
    for (const p of rt.pins) {
      if (!p.el || !p.el.isConnected) makePinEl(p);
      p.el!.classList.remove("hidden");
    }
    layout();
  }

  function hidePins(): void {
    for (const p of rt.pins) if (p.el) p.el.classList.add("hidden");
  }

  function onScroll(): void {
    layout();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    if (rt.panel.isOpen()) return; // the composer owns Esc while it is open
    e.preventDefault();
    exit();
  }

  function pick(cx: number, cy: number): void {
    if (rt.panel.isOpen()) return;
    const anchor = computeAnchor(cx, cy, rt.host, capture);
    const pin: Pin = {
      n: rt.pins.length + 1,
      docX: cx + window.scrollX,
      docY: cy + window.scrollY,
      clientX: cx,
      clientY: cy,
      status: "pending",
      anchor,
      body: "",
      reviewer: null,
      at: "",
      el: null,
    };
    rt.pins.push(pin);
    makePinEl(pin);
    layout();
    captureOff();
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
    label.textContent = HINT_TEXT;
    const done = document.createElement("button");
    done.type = "button";
    done.textContent = "Done";
    done.addEventListener("click", exit);
    hint.appendChild(label);
    hint.appendChild(done);

    root.appendChild(capture);
    root.appendChild(hint);
    showPins();

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    document.addEventListener("keydown", onKey, true);
    rt.trigger.classList.add("hidden");
    done.focus();
  }

  function exit(): void {
    if (!active) return;
    active = false;
    if (rt.panel.isOpen()) rt.panel.close(false);
    if (capture) {
      capture.remove();
      capture = null;
    }
    if (hint) {
      hint.remove();
      hint = null;
    }
    // Keep pins visible if the comment drawer is showing them.
    if (!rt.drawer || !rt.drawer.isOpen()) hidePins();
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
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
    rt.pins.forEach((pp, idx) => {
      pp.n = idx + 1;
      if (pp.el) {
        const s = pp.el.querySelector("span");
        if (s) s.textContent = String(pp.n);
      }
    });
    if (rt.drawer) rt.drawer.refresh();
  }

  function isActive(): boolean {
    return active;
  }

  function destroy(): void {
    exit();
    for (const p of rt.pins) {
      if (p.el) p.el.remove();
      p.el = null;
    }
  }

  return {
    enter,
    exit,
    layout,
    captureOn,
    captureOff,
    removePin,
    showPins,
    hidePins,
    isActive,
    focus,
    destroy,
  };
}
