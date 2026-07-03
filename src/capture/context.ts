/**
 * Environment + identity capture. Everything here is defensive: no call may
 * throw, because these run inside user event handlers and during init.
 */
import type { FeedbackPayload } from "../types";

/**
 * RFC-4122 v4 UUID. Prefers `crypto.randomUUID` (secure contexts), falls back
 * to `crypto.getRandomValues`, and finally to a non-crypto Math.random source
 * so it NEVER throws (e.g. insecure origins / very old engines).
 */
export function uuid(): string {
  try {
    const c: Crypto | undefined = (globalThis as { crypto?: Crypto }).crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    if (c && typeof c.getRandomValues === "function") {
      const b = c.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = (n: number) => (n + 0x100).toString(16).slice(1);
      return (
        h(b[0]) + h(b[1]) + h(b[2]) + h(b[3]) + "-" +
        h(b[4]) + h(b[5]) + "-" +
        h(b[6]) + h(b[7]) + "-" +
        h(b[8]) + h(b[9]) + "-" +
        h(b[10]) + h(b[11]) + h(b[12]) + h(b[13]) + h(b[14]) + h(b[15])
      );
    }
  } catch {
    /* fall through */
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** location.pathname + search + hash */
export function route(): string {
  const l = location;
  return l.pathname + l.search + l.hash;
}

/** ISO-8601 timestamp with timezone designator (Z). */
export function nowISO(): string {
  return new Date().toISOString();
}

/** Best-effort environment snapshot. Every probe fails soft (0 / false). */
export function env(): FeedbackPayload["env"] {
  let sw = 0;
  let sh = 0;
  let dpr = 0;
  try {
    sw = (screen && screen.width) || 0;
    sh = (screen && screen.height) || 0;
  } catch {
    /* ignore */
  }
  try {
    dpr = Math.round((window.devicePixelRatio || 0) * 100) / 100;
  } catch {
    /* ignore */
  }
  return {
    user_agent: (navigator && navigator.userAgent) || "",
    language: (navigator && navigator.language) || "",
    screen: { w: sw, h: sh },
    dpr,
    dark: media("(prefers-color-scheme: dark)"),
    touch: media("(pointer: coarse)"),
  };
}

function media(q: string): boolean {
  try {
    return !!window.matchMedia(q).matches;
  } catch {
    return false;
  }
}
