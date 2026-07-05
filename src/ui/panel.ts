/**
 * The composer: role="dialog", focus-trapped, anchored near the pin (flipping to
 * stay in the viewport). Textarea (required, max 2000, live counter), optional
 * name input, Submit/Cancel, spinner, success/failure states, copy-to-clipboard
 * on failure, and the branding footer. Esc dismisses the composer but KEEPS the
 * typed draft (only Cancel discards it); a second Esc (handled by the overlay)
 * leaves comment mode. Cmd/Ctrl+Enter submits. Focus returns on close.
 * While the composer is untouched, clicking elsewhere on the page abandons the
 * pending pin and re-pins at the new spot (see overlay.pick / abandonClean).
 */
import type { Panel, Pin, Runtime } from "../index";
import { env, nowISO, route, uuid } from "../capture/context";
import { getPageErrors } from "../capture/errors";
import { send } from "../transport/webhook";
import type { FeedbackPayload } from "../types";

const MAX = 2000;
/** Counter switches from dimmed to the flag colour at this length. */
const WARN = 1800;
/** Mobile breakpoint: at/below this the composer is a bottom sheet (CSS). */
const SHEET_MAX = 640;

/**
 * Human-readable description of what a pin is anchored to, used by the
 * capture chip: element text → label → selector → percent fallback.
 */
export function chipLabel(anchor: Pin["anchor"]): string {
  const el = anchor && anchor.element;
  if (el && el.text) return el.tag + ' "' + el.text + '"';
  if (el && el.label) return el.tag + ' "' + el.label + '"';
  if (anchor && anchor.selector) return anchor.selector;
  return anchor ? anchor.x_pct + "%, " + anchor.y_pct + "%" : "";
}

/** The root pin a reply belongs to, or null for top-level pins / gone roots. */
export function replyRoot(rt: Runtime, pin: Pin): Pin | null {
  if (pin.replyToId === null) return null;
  return rt.pins.find((q) => q.replyToId === null && q.id === pin.replyToId) || null;
}

/**
 * The body as delivered: replies carry the "Re #N:" linkage prefix in the
 * payload (the transport has no thread schema of its own). Bodies that already
 * start with a prefix — legacy restores, or a reviewer typing it — are kept.
 */
export function deliveredBody(rt: Runtime, pin: Pin, body: string): string {
  const root = replyRoot(rt, pin);
  if (!root || /^Re #\d+:/.test(body)) return body;
  return "Re #" + root.n + ": " + body;
}

/**
 * Payload for a pin's comment. Shared by the composer's submit and the
 * drawer's retry-after-reload; `createdAt` preserves the original write time
 * on retries.
 */
export function buildPayload(
  rt: Runtime,
  pin: Pin,
  body: string,
  name: string | null,
  createdAt?: string,
): FeedbackPayload {
  return {
    schema: 2,
    id: uuid(),
    created_at: createdAt || nowISO(),
    project_name: rt.cfg.projectName,
    app_version: rt.cfg.appVersion,
    route: route(),
    url: location.href,
    body,
    reviewer_name: rt.cfg.fieldName ? name || null : null,
    session_id: rt.sessionId,
    anchor: pin.anchor,
    env: env(),
    page_errors: getPageErrors(),
  };
}

export function createPanel(rt: Runtime): Panel {
  let el: HTMLElement | null = null;
  let currentPin: Pin | null = null;
  let sending = false;
  /** Whether the composer has content (typed, drafted, or prefilled). While
   *  false the overlay's capture layer stays on so a click elsewhere re-pins. */
  let touched = false;
  let successTimer: ReturnType<typeof setTimeout> | null = null;

  let ta!: HTMLTextAreaElement;
  let nameIn: HTMLInputElement | null = null;
  let submitBtn!: HTMLButtonElement;
  let counter!: HTMLElement;
  let status!: HTMLElement;
  /** Root pin marker highlighted while its reply composer is open. */
  let ringEl: HTMLElement | null = null;

  function isOpen(): boolean {
    return !!el;
  }

  function focusables(): HTMLElement[] {
    if (!el) return [];
    const list = el.querySelectorAll<HTMLElement>("textarea,input,button,a[href]");
    return Array.prototype.filter.call(
      list,
      (n: HTMLElement) => !(n as HTMLButtonElement).disabled,
    ) as HTMLElement[];
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // Esc is a habit key: abandon the pin but keep the typed draft.
      // Only the explicit Cancel button discards text.
      dismiss(true);
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key !== "Tab") return;
    const f = focusables();
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    const act = rt.root.activeElement as HTMLElement | null;
    if (e.shiftKey && act === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && act === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function updateCounter(): void {
    counter.textContent = ta.value.length + " / " + MAX;
    counter.classList.toggle("warn", ta.value.length >= WARN);
    submitBtn.disabled = sending || ta.value.trim().length === 0;
  }

  function onInput(): void {
    if (!touched) {
      touched = true;
      rt.overlay.captureOff(); // composer has content — clicks belong to the page again
    }
    updateCounter();
    rt.saveDraft({ body: ta.value, name: nameIn ? nameIn.value : "" });
  }

  function build(): void {
    el = document.createElement("div");
    el.className = "panel";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Leave a comment");
    el.addEventListener("keydown", onKey);

    // Capture chip: the machine-voice line naming what the pin is anchored to.
    // Replies show the thread linkage instead — the "Re #N:" prefix is added
    // at send time, so the textarea stays clean and the link can't be broken
    // by editing.
    if (currentPin) {
      const chip = document.createElement("div");
      chip.className = "chip";
      const root = replyRoot(rt, currentPin);
      if (root) {
        chip.classList.add("reply");
        chip.textContent = "↳ Replying to #" + root.n;
        chip.setAttribute("aria-label", "Replying to comment " + root.n);
      } else {
        const lbl = chipLabel(currentPin.anchor);
        chip.textContent = "⌖ " + lbl;
        chip.setAttribute("aria-label", "Commenting on " + lbl);
      }
      chip.setAttribute("aria-hidden", "false");
      el.appendChild(chip);
    }

    ta = document.createElement("textarea");
    ta.maxLength = MAX;
    ta.setAttribute("aria-label", "Comment");
    ta.placeholder = "Describe the issue or idea…";
    ta.addEventListener("input", onInput);
    el.appendChild(ta);

    counter = document.createElement("div");
    counter.className = "counter";
    el.appendChild(counter);

    if (rt.cfg.fieldName) {
      nameIn = document.createElement("input");
      nameIn.type = "text";
      nameIn.maxLength = 80;
      nameIn.placeholder = "Your name (optional)";
      nameIn.setAttribute("aria-label", "Your name");
      el.appendChild(nameIn);
    } else {
      nameIn = null;
    }

    const row = document.createElement("div");
    row.className = "row";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", cancel);
    submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "btn-submit";
    submitBtn.textContent = "Send";
    submitBtn.addEventListener("click", () => {
      void submit();
    });
    row.appendChild(cancelBtn);
    row.appendChild(submitBtn);
    el.appendChild(row);

    status = document.createElement("div");
    status.className = "status";
    status.setAttribute("aria-live", "polite");
    el.appendChild(status);

    if (rt.cfg.branding) {
      const foot = document.createElement("div");
      foot.className = "foot";
      foot.innerHTML =
        'Built by <a href="https://frontierops.dev" target="_blank" rel="noopener">Frontier Operations</a>';
      el.appendChild(foot);
    }

    rt.root.appendChild(el);
    updateCounter();
  }

  function position(pin: Pin): void {
    if (!el) return;
    if (window.innerWidth <= SHEET_MAX) {
      // Bottom-sheet mode: CSS places the composer; don't anchor to the pin.
      el.style.left = "";
      el.style.top = "";
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pw = el.offsetWidth || 300;
    const ph = el.offsetHeight || 240;
    const gap = 14;

    let left = pin.clientX + gap;
    if (left + pw > vw - 8) left = pin.clientX - gap - pw;
    if (left < 8) left = 8;

    let top = pin.clientY + gap;
    if (top + ph > vh - 8) top = pin.clientY - gap - ph;
    if (top < 8) top = 8;

    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  function open(pin: Pin, prefill?: string): void {
    if (el) close(false);
    currentPin = pin;
    sending = false;
    build();
    position(pin);
    // Replying in place: keep the thread's root pin visibly the subject.
    const root = replyRoot(rt, pin);
    if (root && root.el) {
      ringEl = root.el;
      ringEl.classList.add("ring");
    }
    rt.overlay.syncPins(); // composer open = widget engaged (full-strength pins)
    if (prefill) {
      ta.value = prefill;
      updateCounter();
    } else if (rt.pendingDraft) {
      ta.value = rt.pendingDraft.body || "";
      if (nameIn) nameIn.value = rt.pendingDraft.name || "";
      updateCounter();
    }
    touched = ta.value.trim().length > 0;
    if (touched) rt.overlay.captureOff();
    ta.focus();
    const n = ta.value.length;
    if (n) {
      try {
        ta.setSelectionRange(n, n); // cursor at the end (after any prefill)
      } catch {
        /* ignore */
      }
    }
  }

  function setSending(on: boolean): void {
    submitBtn.disabled = on || ta.value.trim().length === 0;
    submitBtn.innerHTML = on ? '<span class="spinner"></span>' : "Send";
  }

  async function submit(): Promise<void> {
    if (sending || !currentPin) return;
    const pin = currentPin;
    const typed = ta.value.trim();
    const name = nameIn ? nameIn.value.trim() : "";
    if (!typed) {
      ta.focus();
      return;
    }
    sending = true;
    setSending(true);
    status.className = "status";
    status.textContent = "";

    const body = deliveredBody(rt, pin, typed);
    const payload = buildPayload(rt, pin, body, name);
    pin.body = body;
    pin.reviewer = rt.cfg.fieldName ? name || null : null;
    pin.at = payload.created_at;

    let ok = false;
    try {
      const res = await send(rt.cfg.webhook, rt.cfg.transport, payload);
      ok = res.ok;
    } catch {
      ok = false; // send() shouldn't throw, but never let it bubble
    }
    sending = false;
    if (!el) return; // composer was closed/destroyed mid-flight

    if (ok) {
      pin.status = "sent";
      pin.deliveredId = payload.id; // the receipt capability for this comment
      if (pin.el) {
        pin.el.classList.remove("failed");
        pin.el.classList.add("sent");
      }
      rt.clearDraft();
      rt.savePins();
      rt.saveReceipts();
      rt.drawer.refresh();
      submitBtn.disabled = true;
      status.className = "status ok";
      status.textContent = "✓ Sent — thank you";
      successTimer = setTimeout(() => close(true), 1500);
    } else {
      pin.status = "failed";
      if (pin.el) pin.el.classList.add("failed");
      rt.saveDraft({ body: typed, name });
      rt.savePins();
      rt.drawer.refresh();
      showFailure(body);
    }
  }

  function showFailure(body: string): void {
    setSending(false);
    submitBtn.innerHTML = "Retry";
    submitBtn.disabled = false;
    status.className = "status err";
    status.textContent = "Couldn't send. ";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "btn-cancel";
    copy.textContent = "Copy your comment";
    copy.style.cssText = "flex:none;padding:4px 8px;margin-left:6px";
    copy.addEventListener("click", () => {
      void copyText(body).then((done) => {
        copy.textContent = done ? "Copied ✓" : "Copy failed";
      });
    });
    status.appendChild(copy);
  }

  async function copyText(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall back */
    }
    try {
      const tmp = document.createElement("textarea");
      tmp.value = text;
      tmp.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      rt.root.appendChild(tmp); // stay inside our shadow root, not host DOM
      tmp.select();
      const done = document.execCommand("copy");
      tmp.remove();
      return done;
    } catch {
      return false;
    }
  }

  /** Cancel button: abandon the pending pin AND discard the typed draft. */
  function cancel(): void {
    if (currentPin && currentPin.status === "pending") rt.overlay.removePin(currentPin);
    rt.clearDraft();
    close(true);
  }

  /** Esc / leaving comment mode: abandon the pending pin, keep the draft. */
  function dismiss(restoreFocus: boolean): void {
    if (currentPin && currentPin.status === "pending") rt.overlay.removePin(currentPin);
    close(restoreFocus);
  }

  function abandonClean(): boolean {
    if (!el || !currentPin || currentPin.status !== "pending" || touched) return false;
    rt.overlay.removePin(currentPin);
    close(false);
    return true;
  }

  function close(restoreFocus: boolean): void {
    if (successTimer) {
      clearTimeout(successTimer);
      successTimer = null;
    }
    if (el) {
      el.remove();
      el = null;
    }
    currentPin = null;
    sending = false;
    if (ringEl) {
      ringEl.classList.remove("ring");
      ringEl = null;
    }
    rt.overlay.captureOn();
    // Pins stay on the page (overlay policy); this just updates emphasis.
    rt.overlay.syncPins();
    if (restoreFocus) rt.overlay.focus();
  }

  function destroy(): void {
    if (successTimer) {
      clearTimeout(successTimer);
      successTimer = null;
    }
    if (el) {
      el.remove();
      el = null;
    }
    if (ringEl) {
      ringEl.classList.remove("ring");
      ringEl = null;
    }
    currentPin = null;
  }

  return { open, close, isOpen, abandonClean, dismiss, destroy };
}
