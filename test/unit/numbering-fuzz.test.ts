import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { init, destroy } from "../../src/index";
import {
  installLayout,
  mockFetch,
  mockPointStack,
  fillComment,
  submit,
  getShadow,
  cleanup,
} from "./helpers";

/**
 * Property test: no two on-page markers (root pins) may ever show the same
 * number, and no two root-rendered drawer entries may share a badge — across
 * ANY interleaving of: comment (sent/failed), follow-up (sent/failed), retry,
 * discard, and reload-with-persist ("session reuse").
 *
 * Born from a real screenshot: two page pins both numbered 4 after a session
 * that spanned a reload. If this fuzzer trips, the failing seed + action log
 * is printed for a deterministic repro.
 */

const CONFIG = { webhook: "https://example.test/hook", appVersion: "1.0.0" };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shadow(): ShadowRoot {
  return getShadow();
}

function pressEscape(target: EventTarget): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
}

function composer(): HTMLElement | null {
  return shadow().querySelector<HTMLElement>('[aria-label="Leave a comment"]');
}

function enterMode(): void {
  const t = shadow().querySelector<HTMLElement>('[aria-label="Give feedback"]');
  if (t && !t.classList.contains("hidden")) {
    t.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
}

function exitMode(): void {
  pressEscape(document); // overlay's document-level capture handler
}

function clickCapture(x: number, y: number): void {
  const cap = shadow().querySelector<HTMLElement>(".capture");
  if (!cap) throw new Error("capture layer missing — not in comment mode?");
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y });
  cap.dispatchEvent(ev);
}

function openDrawer(): void {
  const t = shadow().querySelector<HTMLButtonElement>('[aria-label="View comments"]');
  if (t && t.getAttribute("aria-expanded") !== "true") {
    t.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
}

function closeDrawer(): void {
  const t = shadow().querySelector<HTMLButtonElement>('[aria-label="View comments"]');
  if (t && t.getAttribute("aria-expanded") === "true") {
    t.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
}

function drawerButtons(prefix: string): HTMLButtonElement[] {
  return Array.from(
    shadow().querySelectorAll<HTMLButtonElement>("button"),
  ).filter((b) => (b.getAttribute("aria-label") || "").startsWith(prefix));
}

async function settleSubmit(ok: boolean, log: string[]): Promise<void> {
  const fetchMock = mockFetch({ status: ok ? 200 : 500, body: ok ? { ok: true } : { ok: false } });
  fillComment("fuzz " + log.length + " " + (ok ? "ok" : "fail"));
  submit();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  if (ok) {
    await vi.advanceTimersByTimeAsync(1600); // success auto-close
  } else {
    await vi.advanceTimersByTimeAsync(2100); // transport's automatic retry
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const c = composer();
    if (c) pressEscape(c); // dismiss failed composer, keep the failed pin
  }
}

/** The invariant from the bug screenshot: unique numbers, everywhere visible. */
function assertNoDuplicates(seed: number, log: string[]): void {
  const markers = Array.from(shadow().querySelectorAll(".pin span")).map(
    (s) => s.textContent || "?",
  );
  const dupMarkers = markers.filter((n, i) => markers.indexOf(n) !== i);
  const entries = Array.from(
    shadow().querySelectorAll(".entry:not(.reply) .n"),
  )
    .map((s) => s.textContent || "?")
    .filter((t) => t !== "↳");
  const dupEntries = entries.filter((n, i) => entries.indexOf(n) !== i);
  if (dupMarkers.length || dupEntries.length) {
    throw new Error(
      `DUPLICATE NUMBERS seed=${seed}\n` +
        `  markers=[${markers.join(",")}] entries=[${entries.join(",")}]\n` +
        `  after actions:\n  ${log.join("\n  ")}`,
    );
  }
}

describe("pin numbering fuzz (unique numbers under any action sequence)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installLayout({ docW: 1000, docH: 2000, vw: 800, vh: 600 });
    localStorage.clear();
    const target = document.createElement("button");
    target.id = "cta";
    document.body.appendChild(target);
    mockPointStack([target]);
  });

  afterEach(async () => {
    vi.useRealTimers();
    localStorage.clear();
    await cleanup(destroy);
  });

  it("holds across 120 random sessions", async () => {
    for (let seed = 1; seed <= 120; seed++) {
      const rnd = mulberry32(seed);
      const log: string[] = [];
      localStorage.clear();
      init(CONFIG);
      try {
        const steps = 6 + Math.floor(rnd() * 6);
        for (let s = 0; s < steps; s++) {
          const roll = rnd();
          if (roll < 0.3) {
            const ok = rnd() < 0.5;
            log.push(`comment ${ok ? "ok" : "fail"}`);
            closeDrawer();
            enterMode();
            clickCapture(50 + Math.floor(rnd() * 700), 50 + Math.floor(rnd() * 500));
            await settleSubmit(ok, log);
            exitMode();
          } else if (roll < 0.5) {
            openDrawer();
            const fu = drawerButtons("Add follow-up");
            if (fu.length) {
              const ok = rnd() < 0.5;
              const pick = fu[Math.floor(rnd() * fu.length)];
              log.push(`followup(${pick.getAttribute("aria-label")}) ${ok ? "ok" : "fail"}`);
              pick.dispatchEvent(new MouseEvent("click", { bubbles: true }));
              await settleSubmit(ok, log);
            } else {
              closeDrawer();
            }
          } else if (roll < 0.65) {
            openDrawer();
            const rb = drawerButtons("Retry sending");
            if (rb.length) {
              const pick = rb[Math.floor(rnd() * rb.length)];
              log.push(`retry(${pick.getAttribute("aria-label")})`);
              const fetchMock = mockFetch({ status: 200, body: { ok: true } });
              pick.dispatchEvent(new MouseEvent("click", { bubbles: true }));
              await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
              await vi.advanceTimersByTimeAsync(50);
            } else {
              closeDrawer();
            }
          } else if (roll < 0.8) {
            openDrawer();
            const db = drawerButtons("Discard");
            if (db.length) {
              const pick = db[Math.floor(rnd() * db.length)];
              log.push(`discard(${pick.getAttribute("aria-label")})`);
              pick.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            } else {
              closeDrawer();
            }
          } else {
            log.push("reload");
            destroy();
            init(CONFIG);
          }
          await vi.advanceTimersByTimeAsync(200); // let debounced reprojection fire
          assertNoDuplicates(seed, log);
        }
        openDrawer();
        assertNoDuplicates(seed, log);
        closeDrawer();
      } finally {
        destroy();
      }
    }
  }, 120_000);

  it("sanitizes hostile/legacy localStorage from older builds", async () => {
    const key = "tyrekick:pins:" + location.pathname;
    const anchor = {
      x_pct: 10,
      y_pct: 10,
      selector: "#cta",
      viewport: { w: 800, h: 600 },
      element: null,
      context: { heading: null, landmark: null },
    };
    // Every shape an old build could have left behind: duplicate numbers,
    // gaps, sent entries (pre-unsent-only contract), prefix-linked follow-ups
    // whose roots are missing, and entries with no ids at all.
    const hostile = [
      { n: 4, x: 100, y: 100, s: "failed", a: anchor, b: "dup four A", r: null, t: "2026-07-04T21:55:00Z" },
      { n: 4, x: 200, y: 200, s: "failed", a: anchor, b: "dup four B", r: null, t: "2026-07-04T21:56:00Z" },
      { n: 9, x: 300, y: 300, s: "failed", a: anchor, b: "gap nine", r: null, t: "2026-07-04T22:00:00Z" },
      { n: 2, x: 400, y: 400, s: "sent", a: anchor, b: "sent legacy", r: null, t: "2026-07-04T22:01:00Z" },
      { n: 5, x: 500, y: 500, s: "failed", a: anchor, b: "Re #4: reply to ambiguous root", r: "Dave", t: "2026-07-04T22:02:00Z" },
      { n: 7, x: 600, y: 600, s: "failed", a: anchor, b: "Re #99: reply to missing root", r: null, t: "2026-07-04T22:03:00Z" },
    ];
    localStorage.setItem(key, JSON.stringify(hostile));

    init(CONFIG);
    await vi.advanceTimersByTimeAsync(200);
    assertNoDuplicates(0, ["restore hostile storage"]);
    openDrawer();
    assertNoDuplicates(0, ["restore hostile storage", "open drawer"]);
    closeDrawer();

    // New comments after a hostile restore must keep the invariant too.
    enterMode();
    clickCapture(300, 300);
    const log: string[] = ["restore hostile storage"];
    await settleSubmit(true, log);
    exitMode();
    openDrawer();
    assertNoDuplicates(0, log.concat("comment ok", "open drawer"));
  });
});
