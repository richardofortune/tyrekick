/**
 * IIFE entry (dist/tyrekick.js, global `Tyrekick`). Re-exports the public API and
 * auto-initialises from data-* attributes on its own <script> tag.
 *
 *   <script src="tyrekick.js" data-webhook="…" data-app-version="1.0"></script>
 */
export { init, destroy } from "./index";

import { init } from "./index";
import type { Position, Transport } from "./types";

// Must be read synchronously at eval time — currentScript is null by the time
// DOMContentLoaded fires.
const self = document.currentScript as HTMLScriptElement | null;

function boot(): void {
  if (!self) return;
  const d = self.dataset;
  if (!d.webhook) return; // no auto-init requested
  try {
    init({
      webhook: d.webhook,
      appVersion: d.appVersion || "",
      projectName: d.projectName,
      transport: d.transport as Transport | undefined,
      accent: d.accent,
      position: d.position as Position | undefined,
      branding: d.branding === "false" ? false : undefined,
      captureErrors: d.captureErrors === "false" ? false : undefined,
    });
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
