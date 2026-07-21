/**
 * IIFE entry (dist/tyrekick.js, global `Tyrekick`). Re-exports the public API and
 * auto-initialises from data-* attributes on its own <script> tag.
 *
 *   <script src="tyrekick.js" data-webhook="…" data-app-version="1.0"></script>
 *
 * For framework/async loaders (next/script, dynamic import, bundlers) where
 * `document.currentScript` is null, set a global instead:
 *
 *   <script>window.tyrekickConfig = { webhook: "…", appVersion: "1.0" }</script>
 */
export { init, destroy } from "./index";

import { init } from "./index";
import type { Position, Transport, TyrekickConfig } from "./types";

// Must be read synchronously at eval time — currentScript is null by the time
// DOMContentLoaded fires, and also null whenever the script is injected
// asynchronously (next/script, dynamic import, bundlers). Kept for the classic
// synchronous <script src> path; resolveAutoConfig falls back for the rest.
const self = document.currentScript as HTMLScriptElement | null;

/** Map a script tag's data-* attributes to a config, or null when data-webhook
 *  is absent (i.e. that tag is not requesting auto-init). */
function fromDataset(d: DOMStringMap): TyrekickConfig | null {
  if (!d.webhook) return null;
  return {
    webhook: d.webhook,
    appVersion: d.appVersion || "",
    projectName: d.projectName,
    transport: d.transport as Transport | undefined,
    accent: d.accent,
    theme: d.theme as "auto" | "light" | "dark" | undefined,
    position: d.position as Position | undefined,
    branding: d.branding === "false" ? false : undefined,
    captureErrors: d.captureErrors === "false" ? false : undefined,
    reviewKey: d.reviewKey,
  };
}

/**
 * Resolve the auto-init config in priority order:
 *   1. `window.tyrekickConfig` — an explicit global; the reliable path for
 *      framework/async loaders where `document.currentScript` is null.
 *   2. this script's own data-* attributes — the classic synchronous <script>.
 *   3. any `<script data-webhook>` in the DOM — best-effort fallback for a tag
 *      injected asynchronously, so currentScript never pointed at it.
 * Returns null when no source requested auto-init.
 */
export function resolveAutoConfig(
  script: HTMLScriptElement | null,
): TyrekickConfig | null {
  const global = (globalThis as { tyrekickConfig?: TyrekickConfig })
    .tyrekickConfig;
  if (global && global.webhook) {
    return { ...global, appVersion: global.appVersion || "" };
  }
  if (script) {
    const own = fromDataset(script.dataset);
    if (own) return own;
  }
  const tagged = document.querySelector<HTMLScriptElement>(
    "script[data-webhook]",
  );
  return tagged ? fromDataset(tagged.dataset) : null;
}

function boot(): void {
  const config = resolveAutoConfig(self);
  if (!config) return; // no auto-init requested
  try {
    init(config);
  } catch (err) {
    // Auto-init failures (e.g. missing data-app-version) must not surface as an
    // uncaught error during page load.
    console.error("[Tyrekick] auto-init failed:", err);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
