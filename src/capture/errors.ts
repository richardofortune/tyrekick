/**
 * Page-error buffer for `page_errors` (schema v2). Listens to window "error"
 * and "unhandledrejection" — console is NEVER patched — and keeps the last 5
 * messages (each ≤200 chars, oldest first). Fully passive: never preventDefault,
 * never rethrows, never throws itself. Gated by config `captureErrors`.
 */

const MAX_ERRORS = 5;
const MAX_LEN = 200;

let buf: string[] = [];
let listening = false;

function push(v: unknown): void {
  try {
    buf.push(String(v).slice(0, MAX_LEN));
    if (buf.length > MAX_ERRORS) buf.shift();
  } catch {
    /* even String() can throw on hostile objects — drop it */
  }
}

function onError(e: Event): void {
  push((e as ErrorEvent).message);
}

function onRejection(e: Event): void {
  push((e as PromiseRejectionEvent).reason);
}

/** Reset the buffer and (when enabled) install the window listeners. */
export function startErrors(captureErrors: boolean): void {
  buf = [];
  if (!captureErrors || listening) return;
  try {
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    listening = true;
  } catch {
    /* ignore */
  }
}

/** Copy of the buffered messages, oldest first. [] when capture is off. */
export function getPageErrors(): string[] {
  return buf.slice();
}

/** Remove the listeners (destroy()). The buffer is cleared on next start. */
export function stopErrors(): void {
  if (!listening) return;
  try {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  } catch {
    /* ignore */
  }
  listening = false;
}
