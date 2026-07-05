/**
 * Right-hand comment drawer: lists this session's submitted comments (pin
 * number, text, reviewer, time, status) and scrolls to / pulses the matching
 * pin on click. Toggled by a small floating button that appears above the
 * trigger once at least one comment exists. Lives entirely in the shadow root.
 *
 * Also owns the on-page thread popover: clicking a pin opens its comment
 * thread right at the pin (same entries, same Retry/Discard/Follow up
 * actions), so the drawer is the overview and the pin is the door.
 */
import type { Drawer, Pin, Runtime } from "../index";
import { buildPayload } from "./panel";
import { send } from "../transport/webhook";

const LIST_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path fill="currentColor" d="M4 6h2v2H4zm4 0h12v2H8zM4 11h2v2H4zm4 0h12v2H8zM4 16h2v2H4zm4 0h12v2H8z"/>' +
  "</svg>";

export function createDrawer(rt: Runtime): Drawer {
  let el: HTMLElement | null = null;
  let list: HTMLElement | null = null;
  let count: HTMLElement;
  let toggle: HTMLButtonElement;
  let eye: HTMLButtonElement | null = null;
  /** Thread popover state (open at most one, anchored to its root pin). */
  let pop: HTMLElement | null = null;
  let popList: HTMLElement | null = null;
  let popPin: Pin | null = null;

  function submitted(): Pin[] {
    return rt.pins.filter((p) => p.status !== "pending");
  }

  function isOpen(): boolean {
    return !!el;
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  function fmtTime(iso: string): string {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  /** A reply's page presence is its root pin — resolve to it for scroll/pulse. */
  function rootOf(p: Pin): Pin {
    if (p.replyToId === null) return p;
    return rt.pins.find((q) => q.replyToId === null && q.id === p.replyToId) || p;
  }

  function locate(p: Pin): void {
    const target = rootOf(p);
    // If the pin would sit under the open drawer, close the drawer so the
    // pulse is actually visible (pins themselves stay on the page).
    if (el) {
      const dw = el.offsetWidth || 320;
      if (target.docX - window.scrollX >= window.innerWidth - dw) close();
    }
    window.scrollTo({
      top: Math.max(0, target.docY - window.innerHeight / 2),
      behavior: "smooth",
    });
    if (target.el) {
      target.el.classList.remove("pulse");
      // restart the animation if the same pin is clicked twice
      void target.el.offsetWidth;
      target.el.classList.add("pulse");
    }
  }

  /** Resend a failed comment (drawer path — used after a reload, when the
   *  composer's own Retry is long gone). Original write time is preserved. */
  async function retry(p: Pin, btn: HTMLButtonElement): Promise<void> {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "Sending…";
    let ok = false;
    let sentId: string | null = null;
    try {
      const payload = buildPayload(rt, p, p.body, p.reviewer, p.at || undefined);
      sentId = payload.id;
      ok = (await send(rt.cfg.webhook, rt.cfg.transport, payload)).ok;
    } catch {
      ok = false;
    }
    if (p.status !== "failed") return; // discarded or re-sent elsewhere mid-flight
    if (ok) {
      p.status = "sent";
      p.deliveredId = sentId;
      if (p.el) {
        p.el.classList.remove("failed");
        p.el.classList.add("sent");
      }
      rt.savePins();
      rt.saveReceipts();
      refresh();
    } else {
      btn.disabled = false;
      btn.textContent = "Retry";
    }
  }

  /** Drop an unsent comment for good (it never reached the destination). */
  function discard(p: Pin): void {
    rt.overlay.removePin(p); // also renumbers and refreshes this drawer
    rt.savePins();
  }

  /** "Got it": the reviewer acknowledges a closed comment — its mark is done.
   *  Dismissing a root takes its replies with it (the thread closed together). */
  function acknowledge(p: Pin): void {
    for (const c of rt.pins.filter((q) => q.replyToId === p.id)) rt.overlay.removePin(c);
    rt.overlay.removePin(p);
    rt.saveReceipts();
  }

  /**
   * Follow-up: bring the root pin on screen and open the composer on a
   * marker-less reply that carries the root's anchor. Following up on a reply
   * joins the same thread. No prefill: the composer shows a "Replying to #N"
   * chip and submit adds the "Re #N:" prefix at send time.
   */
  function followUp(p: Pin): void {
    closeThread();
    close();
    const root = rootOf(p);
    locate(root);
    const np = rt.overlay.addPin(root.docX, root.docY, root.anchor, root.id);
    rt.panel.open(np);
  }

  function threadEntries(root: Pin): Pin[] {
    const pins = submitted();
    return [root, ...pins.filter((p) => p.replyToId === root.id)];
  }

  function renderList(): void {
    if (!list) return;
    list.textContent = "";
    const pins = submitted();
    if (!pins.length) {
      const empty = document.createElement("div");
      empty.className = "drawer-empty";
      empty.textContent = "No comments yet.";
      list.appendChild(empty);
      return;
    }
    const kids = new Map<string, Pin[]>();
    const roots: Pin[] = [];
    for (const p of pins) {
      if (
        p.replyToId !== null &&
        pins.some((q) => q.replyToId === null && q.id === p.replyToId)
      ) {
        const arr = kids.get(p.replyToId) || [];
        arr.push(p);
        kids.set(p.replyToId, arr);
      } else {
        roots.push(p); // top-level, or a reply whose root is gone
      }
    }
    for (const p of roots) {
      list.appendChild(makeEntry(p, false, true));
      for (const c of kids.get(p.id) || []) list.appendChild(makeEntry(c, true, true));
    }
  }

  function makeEntry(p: Pin, reply: boolean, locatable: boolean): HTMLElement {
    const thread = rootOf(p);
    const threadNumber = thread.n || p.n;
    const entry = document.createElement("div");
    entry.className =
      "entry" +
      (p.status === "failed" ? " failed" : "") +
      (reply ? " reply" : "") +
      (p.receipt ? (p.receipt.status === "resolved" ? " resolved" : " declined") : "");

    const go = document.createElement("button");
    go.type = "button";
    go.className = "entry-go";
    go.setAttribute(
      "aria-label",
      reply ? "Go to reply on comment " + threadNumber : "Go to comment " + threadNumber,
    );

    const n = document.createElement("span");
    n.className = "n";
    n.textContent = reply ? "↳" : String(p.n);
    go.appendChild(n);

    const main = document.createElement("span");
    main.className = "entry-main";
    const body = document.createElement("span");
    body.className = "body";
    // Nesting already shows the linkage — hide the "Re #N:" prefix (the sent
    // payload keeps it).
    const text = reply ? (p.body || "").replace(/^Re #\d+:\s*/, "") : p.body;
    body.textContent = text || "(no text)";
    main.appendChild(body);
    const meta = document.createElement("span");
    meta.className = "meta";
    const bits: string[] = [];
    if (p.reviewer) bits.push(p.reviewer);
    const t = fmtTime(p.at);
    if (t) bits.push(t);
    if (p.status === "failed") bits.push("not sent");
    if (p.receipt) bits.push(p.receipt.status === "resolved" ? "✓ resolved" : "✕ declined");
    meta.textContent = bits.join(" · ");
    main.appendChild(meta);
    if (p.receipt && p.receipt.note) {
      const note = document.createElement("span");
      note.className = "note";
      note.textContent = p.receipt.note;
      main.appendChild(note);
    }
    go.appendChild(main);

    if (locatable) {
      go.addEventListener("click", () => locate(p));
    } else {
      go.disabled = true; // popover entries are already AT the pin
    }
    entry.appendChild(go);

    const actions = document.createElement("div");
    actions.className = "entry-actions";

    if (p.status === "failed") {
      const rb = document.createElement("button");
      rb.type = "button";
      rb.className = "retry";
      rb.textContent = "Retry";
      rb.setAttribute(
        "aria-label",
        reply ? "Retry sending reply on comment " + threadNumber : "Retry sending comment " + threadNumber,
      );
      rb.addEventListener("click", () => void retry(p, rb));
      actions.appendChild(rb);

      const db = document.createElement("button");
      db.type = "button";
      db.className = "discard";
      db.textContent = "Discard";
      db.setAttribute(
        "aria-label",
        reply ? "Discard reply on comment " + threadNumber : "Discard comment " + threadNumber,
      );
      db.addEventListener("click", () => discard(p));
      actions.appendChild(db);
    }

    if (p.receipt && p.replyToId === null) {
      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "gotit";
      ok.textContent = "Got it";
      ok.setAttribute("aria-label", "Dismiss closed comment " + threadNumber);
      ok.addEventListener("click", () => acknowledge(p));
      actions.appendChild(ok);
    }

    const fu = document.createElement("button");
    fu.type = "button";
    fu.className = "followup";
    fu.textContent = "Follow up";
    fu.setAttribute("aria-label", "Add follow-up to comment " + threadNumber);
    fu.addEventListener("click", () => followUp(p));
    actions.appendChild(fu);

    entry.appendChild(actions);
    return entry;
  }

  /* ---- thread popover (opened by clicking a pin) ---- */

  function onDocClick(e: MouseEvent): void {
    if (!pop) return;
    const path = e.composedPath();
    for (const t of path) {
      if (t === pop) return; // clicks inside the popover keep it open
      if (t instanceof HTMLElement && t.classList && t.classList.contains("pin")) return;
    }
    closeThread();
  }

  function onPopKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeThread(true);
    }
  }

  function positionThread(root: Pin): void {
    if (!pop) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pw = pop.offsetWidth || 280;
    const ph = pop.offsetHeight || 160;
    const gap = 16;
    const cx = root.docX - window.scrollX;
    const cy = root.docY - window.scrollY;
    let left = cx + gap;
    if (left + pw > vw - 8) left = cx - gap - pw;
    if (left < 8) left = 8;
    let top = cy + gap;
    if (top + ph > vh - 8) top = cy - gap - ph;
    if (top < 8) top = 8;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }

  function renderThread(): void {
    if (!popList || !popPin) return;
    popList.textContent = "";
    for (const p of threadEntries(popPin)) {
      popList.appendChild(makeEntry(p, p !== popPin, false));
    }
  }

  function openThread(p: Pin): void {
    const root = rootOf(p);
    if (root.status === "pending") return;
    if (pop && popPin === root) {
      closeThread(true); // clicking the pin again toggles its thread away
      return;
    }
    closeThread();
    if (el) close(); // the pin is the door now; the drawer would cover it

    popPin = root;
    pop = document.createElement("div");
    pop.className = "thread";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Comment " + root.n + " thread");
    pop.addEventListener("keydown", onPopKey);

    const head = document.createElement("div");
    head.className = "thread-head";
    const title = document.createElement("span");
    title.textContent = "Comment #" + root.n;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "Close";
    closeBtn.setAttribute("aria-label", "Close thread");
    closeBtn.addEventListener("click", () => closeThread(true));
    head.appendChild(title);
    head.appendChild(closeBtn);
    pop.appendChild(head);

    popList = document.createElement("div");
    popList.className = "thread-list";
    pop.appendChild(popList);
    renderThread();

    rt.root.appendChild(pop);
    positionThread(root);
    document.addEventListener("click", onDocClick, true);
    closeBtn.focus();
  }

  function closeThread(refocusPin?: boolean): void {
    if (!pop) return;
    const pin = popPin;
    pop.remove();
    pop = null;
    popList = null;
    popPin = null;
    document.removeEventListener("click", onDocClick, true);
    if (refocusPin && pin && pin.el && pin.el.isConnected) pin.el.focus();
  }

  /* ---- drawer panel ---- */

  function open(): void {
    if (el) return;
    closeThread();
    el = document.createElement("div");
    el.className = "drawer";
    el.setAttribute("role", "complementary");
    el.setAttribute("aria-label", "Feedback comments");
    el.addEventListener("keydown", onKey);

    const head = document.createElement("div");
    head.className = "drawer-head";
    const title = document.createElement("span");
    title.textContent = "Comments (" + submitted().length + ")";
    const controls = document.createElement("div");
    controls.className = "drawer-controls";
    eye = document.createElement("button");
    eye.type = "button";
    eye.textContent = rt.overlay.pinsHidden() ? "Show pins" : "Hide pins";
    eye.addEventListener("click", () => {
      rt.overlay.setPinsHidden(!rt.overlay.pinsHidden());
      if (eye) eye.textContent = rt.overlay.pinsHidden() ? "Show pins" : "Hide pins";
    });
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "Close";
    closeBtn.setAttribute("aria-label", "Close comments");
    closeBtn.addEventListener("click", close);
    controls.appendChild(eye);
    controls.appendChild(closeBtn);
    head.appendChild(title);
    head.appendChild(controls);
    el.appendChild(head);

    list = document.createElement("div");
    list.className = "drawer-list";
    el.appendChild(list);
    renderList();

    rt.root.appendChild(el);
    rt.overlay.syncPins();
    rt.checkReceipts(); // opening the overview is a natural moment to refresh statuses
    toggle.setAttribute("aria-expanded", "true");
    closeBtn.focus();
  }

  function close(): void {
    if (!el) return;
    el.remove();
    el = null;
    list = null;
    eye = null;
    // Pins stay on the page (overlay policy); this just updates emphasis.
    rt.overlay.syncPins();
    toggle.setAttribute("aria-expanded", "false");
    toggle.focus();
  }

  function refresh(): void {
    const pins = submitted();
    const n = pins.length;
    count.textContent = String(n);
    toggle.classList.toggle("hidden", n === 0 && !el);
    // Unsent comments need the reviewer's attention — flag the badge red.
    toggle.classList.toggle("failed", pins.some((p) => p.status === "failed"));
    if (el) {
      const title = el.querySelector(".drawer-head span");
      if (title) title.textContent = "Comments (" + n + ")";
      renderList();
    }
    if (pop) {
      // Re-render the open thread; close it if its root pin is gone.
      if (popPin && rt.pins.indexOf(popPin) >= 0) renderThread();
      else closeThread();
    }
    rt.overlay.syncPins();
  }

  function destroy(): void {
    closeThread();
    if (el) {
      el.remove();
      el = null;
      list = null;
      eye = null;
    }
    toggle.remove();
  }

  toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "list-toggle pos-" + rt.cfg.position + " hidden";
  toggle.setAttribute("aria-label", "View comments");
  toggle.setAttribute("aria-expanded", "false");
  toggle.innerHTML = LIST_ICON;
  count = document.createElement("span");
  count.className = "count";
  count.setAttribute("aria-hidden", "true");
  count.textContent = "0";
  toggle.appendChild(count);
  toggle.addEventListener("click", () => (el ? close() : open()));
  rt.root.appendChild(toggle);

  return { open, close, isOpen, openThread, refresh, destroy };
}
