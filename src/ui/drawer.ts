/**
 * Right-hand comment drawer: lists this session's submitted comments (pin
 * number, text, reviewer, time, status) and scrolls to / pulses the matching
 * pin on click. Toggled by a small floating button that appears above the
 * trigger once at least one comment exists. Lives entirely in the shadow root.
 */
import type { Drawer, Pin, Runtime } from "../index";

const LIST_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path fill="currentColor" d="M4 6h2v2H4zm4 0h12v2H8zM4 11h2v2H4zm4 0h12v2H8zM4 16h2v2H4zm4 0h12v2H8z"/>' +
  "</svg>";

export function createDrawer(rt: Runtime): Drawer {
  let el: HTMLElement | null = null;
  let list: HTMLElement | null = null;
  let count: HTMLElement;
  let toggle: HTMLButtonElement;

  function submitted(): Pin[] {
    return rt.pins.filter((p) => p.status !== "pending");
  }

  function isOpen(): boolean {
    return !!el;
  }

  function onScroll(): void {
    rt.overlay.layout();
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

  /**
   * Follow-up: close the drawer, bring the root pin on screen, and open the
   * composer on a marker-less reply that carries the root's anchor. Following
   * up on a reply joins the same thread. In the sent payload the "Re #N:"
   * body prefix is the only linkage — it stays a normal schema-v2 comment.
   */
  function followUp(p: Pin): void {
    close();
    const root = rootOf(p);
    locate(root);
    const np = rt.overlay.addPin(root.docX, root.docY, root.anchor, root.id);
    rt.panel.open(np, "Re #" + root.n + ": ");
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
      list.appendChild(makeEntry(p, false));
      for (const c of kids.get(p.id) || []) list.appendChild(makeEntry(c, true));
    }
  }

  function makeEntry(p: Pin, reply: boolean): HTMLElement {
    const thread = rootOf(p);
    const threadNumber = thread.n || p.n;
    const entry = document.createElement("div");
    entry.className =
      "entry" + (p.status === "failed" ? " failed" : "") + (reply ? " reply" : "");

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
    meta.textContent = bits.join(" · ");
    main.appendChild(meta);
    go.appendChild(main);

    go.addEventListener("click", () => locate(p));
    entry.appendChild(go);

    const fu = document.createElement("button");
    fu.type = "button";
    fu.className = "followup";
    fu.textContent = "Follow up";
    fu.setAttribute("aria-label", "Add follow-up to comment " + threadNumber);
    fu.addEventListener("click", () => followUp(p));
    entry.appendChild(fu);

    return entry;
  }

  function open(): void {
    if (el) return;
    el = document.createElement("div");
    el.className = "drawer";
    el.setAttribute("role", "complementary");
    el.setAttribute("aria-label", "Feedback comments");
    el.addEventListener("keydown", onKey);

    const head = document.createElement("div");
    head.className = "drawer-head";
    const title = document.createElement("span");
    title.textContent = "Comments (" + submitted().length + ")";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "Close";
    closeBtn.setAttribute("aria-label", "Close comments");
    closeBtn.addEventListener("click", close);
    head.appendChild(title);
    head.appendChild(closeBtn);
    el.appendChild(head);

    list = document.createElement("div");
    list.className = "drawer-list";
    el.appendChild(list);
    renderList();

    rt.root.appendChild(el);
    rt.overlay.showPins();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    toggle.setAttribute("aria-expanded", "true");
    closeBtn.focus();
  }

  function close(): void {
    if (!el) return;
    el.remove();
    el = null;
    list = null;
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
    // Keep pins on screen if comment mode is still showing them.
    if (!rt.overlay.isActive()) rt.overlay.hidePins();
    toggle.setAttribute("aria-expanded", "false");
    toggle.focus();
  }

  function refresh(): void {
    const n = submitted().length;
    count.textContent = String(n);
    toggle.classList.toggle("hidden", n === 0 && !el);
    if (el) {
      const title = el.querySelector(".drawer-head span");
      if (title) title.textContent = "Comments (" + n + ")";
      renderList();
    }
  }

  function destroy(): void {
    if (el) {
      el.remove();
      el = null;
      list = null;
    }
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
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

  return { open, close, isOpen, refresh, destroy };
}
