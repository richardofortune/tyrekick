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

  function locate(p: Pin): void {
    window.scrollTo({
      top: Math.max(0, p.docY - window.innerHeight / 2),
      behavior: "smooth",
    });
    if (p.el) {
      p.el.classList.remove("pulse");
      // restart the animation if the same pin is clicked twice
      void p.el.offsetWidth;
      p.el.classList.add("pulse");
    }
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
    for (const p of pins) {
      const entry = document.createElement("button");
      entry.type = "button";
      entry.className = "entry" + (p.status === "failed" ? " failed" : "");
      entry.setAttribute("aria-label", "Go to comment " + p.n);

      const n = document.createElement("span");
      n.className = "n";
      n.textContent = String(p.n);
      entry.appendChild(n);

      const main = document.createElement("span");
      main.className = "entry-main";
      const body = document.createElement("span");
      body.className = "body";
      body.textContent = p.body || "(no text)";
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
      entry.appendChild(main);

      entry.addEventListener("click", () => locate(p));
      list.appendChild(entry);
    }
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
