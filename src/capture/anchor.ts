/**
 * Turns a viewport click point into a FeedbackPayload["anchor"] (schema v2):
 * position percentages, selector, element identity (tag/id/testid/role/
 * text/label/rect), and structural context (nearest heading + landmark path).
 *
 * CRITICAL: the crosshair capture layer sits on top of the page, so a naive
 * elementFromPoint would resolve to the widget itself. We (a) temporarily set
 * the capture layer to pointer-events:none and (b) walk `elementsFromPoint`
 * skipping every node inside the widget host. The resulting target is always
 * a HOST-page element, never one of ours. Nothing here throws — selector /
 * element / heading / landmark are null on any error.
 *
 * PRIVACY: input values are never captured. For input/textarea/select the
 * `text` field is always null (label may carry placeholder/aria-label).
 */
import type { FeedbackPayload } from "../types";

type Anchor = FeedbackPayload["anchor"];
type ElementInfo = NonNullable<Anchor["element"]>;

const MAX_TEXT = 80;
const VALUE_TAGS = /^(input|textarea|select)$/;
const HEADINGS = "h1,h2,h3,h4,h5,h6";
const LANDMARKS = /^(main|nav|header|footer|aside|section|article|form)$/;

export function computeAnchor(
  clientX: number,
  clientY: number,
  host: Element,
  captureLayer: HTMLElement | null,
): Anchor {
  const doc = document.documentElement;
  const sw = doc.scrollWidth || 1;
  const sh = doc.scrollHeight || 1;
  const docX = clientX + window.scrollX;
  const docY = clientY + window.scrollY;
  const target = targetAt(clientX, clientY, host, captureLayer);
  return {
    x_pct: round1((docX / sw) * 100),
    y_pct: round1((docY / sh) * 100),
    selector: target ? cssPath(target, host) : null,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    element: elementInfo(target),
    context: contextOf(target),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Deepest host-page element at the point — never the widget's own nodes. */
function targetAt(
  x: number,
  y: number,
  host: Element,
  captureLayer: HTMLElement | null,
): Element | null {
  const prev = captureLayer ? captureLayer.style.pointerEvents : null;
  try {
    if (captureLayer) captureLayer.style.pointerEvents = "none";
    const stack = document.elementsFromPoint(x, y);
    for (const cand of stack) {
      // Shadow content is retargeted to the host; skip host + anything inside.
      if (cand === host || host.contains(cand)) continue;
      return cand;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (captureLayer && prev !== null) captureLayer.style.pointerEvents = prev;
  }
}

/** Trim + collapse whitespace, cap at 80 chars, null when empty. */
function clip(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  return t || null;
}

/** Identity of the clicked element, or null. Never captures input values. */
function elementInfo(el: Element | null): ElementInfo | null {
  if (!el) return null;
  try {
    const tag = el.tagName.toLowerCase();
    const r = el.getBoundingClientRect();
    const it = (el as HTMLElement).innerText;
    return {
      tag,
      id: el.getAttribute("id") || null,
      testid: el.getAttribute("data-testid") || null,
      role: el.getAttribute("role") || null,
      text: VALUE_TAGS.test(tag) ? null : clip(it != null ? it : el.textContent),
      label: clip(
        el.getAttribute("aria-label") ||
          el.getAttribute("alt") ||
          el.getAttribute("placeholder") ||
          el.getAttribute("title"),
      ),
      rect: {
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
    };
  } catch {
    return null;
  }
}

/** Nearest heading + landmark path. Each half fails soft to null. */
function contextOf(el: Element | null): Anchor["context"] {
  return { heading: heading(el), landmark: landmark(el) };
}

function isHeading(el: Element): boolean {
  return /^h[1-6]$/i.test(el.tagName);
}

/**
 * Walk ancestors from the target; at each level scan previous siblings
 * (nearest first) for the closest h1–h6 — headings nested inside a sibling
 * count too (the last one is closest in document order).
 */
function heading(el: Element | null): string | null {
  try {
    let node: Element | null = el;
    while (node && node !== document.body && node !== document.documentElement) {
      if (isHeading(node)) return clip(node.textContent);
      let sib: Element | null = node.previousElementSibling;
      while (sib) {
        if (isHeading(sib)) return clip(sib.textContent);
        const inner = sib.querySelectorAll(HEADINGS);
        if (inner.length) return clip(inner[inner.length - 1].textContent);
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Coarse landmark path from the target's ancestor chain (target included),
 * up to 3 segments, innermost last — e.g. "main > section#pricing".
 */
function landmark(el: Element | null): string | null {
  try {
    const segs: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.documentElement && segs.length < 3) {
      const tag = node.tagName.toLowerCase();
      if (LANDMARKS.test(tag)) {
        const id = node.getAttribute("id");
        segs.unshift(id ? tag + "#" + id : tag);
      }
      node = node.parentElement;
    }
    return segs.length ? segs.join(" > ") : null;
  } catch {
    return null;
  }
}

/** Deepest → up, max 5 segments, id short-circuits, nth-of-type disambiguates. */
function cssPath(el: Element, host: Element): string | null {
  try {
    const segs: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1 && segs.length < 5) {
      if (node === host || host.contains(node)) break;
      if (node === document.documentElement) {
        segs.unshift("html");
        break;
      }
      if (node === document.body) {
        segs.unshift("body");
        break;
      }
      const id = node.getAttribute("id");
      if (id) {
        segs.unshift("#" + cssEscape(id));
        break;
      }
      let seg = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (parent) {
        const tag = node.tagName;
        const same = Array.prototype.filter.call(
          parent.children,
          (c: Element) => c.tagName === tag,
        ) as Element[];
        if (same.length > 1) seg += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      segs.unshift(seg);
      node = parent;
    }
    return segs.length ? segs.join(" > ") : null;
  } catch {
    return null;
  }
}

function cssEscape(s: string): string {
  const g = globalThis as { CSS?: { escape?: (v: string) => string } };
  if (g.CSS && typeof g.CSS.escape === "function") return g.CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
}
