/**
 * The composer: role="dialog", focus-trapped, anchored near the pin (flipping to
 * stay in the viewport). Textarea (required, max 2000, live counter), optional
 * name input, Submit/Cancel, spinner, success/failure states, copy-to-clipboard
 * on failure, and the branding footer. Esc cancels the composer; a second Esc
 * (handled by the overlay) leaves comment mode. Focus returns on close.
 */
import type { Panel, Pin, Runtime } from "../index";
import { env, nowISO, route, uuid } from "../capture/context";
import { getPageErrors } from "../capture/errors";
import { send } from "../transport/webhook";
import type { FeedbackPayload } from "../types";

const MAX = 2000;

export function createPanel(rt: Runtime): Panel {
  let el: HTMLElement | null = null;
  let currentPin: Pin | null = null;
  let sending = false;
  let successTimer: ReturnType<typeof setTimeout> | null = null;

  let ta!: HTMLTextAreaElement;
  let nameIn: HTMLInputElement | null = null;
  let submitBtn!: HTMLButtonElement;
  let counter!: HTMLElement;
  let status!: HTMLElement;

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
      cancel();
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
    submitBtn.disabled = sending || ta.value.trim().length === 0;
  }

  function onInput(): void {
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

  function open(pin: Pin): void {
    if (el) close(false);
    currentPin = pin;
    sending = false;
    build();
    position(pin);
    if (rt.pendingDraft) {
      ta.value = rt.pendingDraft.body || "";
      if (nameIn) nameIn.value = rt.pendingDraft.name || "";
      updateCounter();
    }
    ta.focus();
  }

  function buildPayload(pin: Pin, body: string, name: string): FeedbackPayload {
    return {
      schema: 2,
      id: uuid(),
      created_at: nowISO(),
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

  function setSending(on: boolean): void {
    submitBtn.disabled = on || ta.value.trim().length === 0;
    submitBtn.innerHTML = on ? '<span class="spinner"></span>' : "Send";
  }

  async function submit(): Promise<void> {
    if (sending || !currentPin) return;
    const pin = currentPin;
    const body = ta.value.trim();
    const name = nameIn ? nameIn.value.trim() : "";
    if (!body) {
      ta.focus();
      return;
    }
    sending = true;
    setSending(true);
    status.className = "status";
    status.textContent = "";

    const payload = buildPayload(pin, body, name);
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
      if (pin.el) {
        pin.el.classList.remove("failed");
        pin.el.classList.add("sent");
      }
      rt.clearDraft();
      rt.savePins();
      rt.drawer.refresh();
      submitBtn.disabled = true;
      status.className = "status ok";
      status.textContent = "✓ Sent — thank you";
      successTimer = setTimeout(() => close(true), 1500);
    } else {
      pin.status = "failed";
      if (pin.el) pin.el.classList.add("failed");
      rt.saveDraft({ body, name });
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

  function cancel(): void {
    if (currentPin && currentPin.status === "pending") rt.overlay.removePin(currentPin);
    rt.clearDraft();
    close(true);
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
    rt.overlay.captureOn();
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
    currentPin = null;
  }

  return { open, close, isOpen, destroy };
}
