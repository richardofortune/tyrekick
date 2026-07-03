/**
 * The 48px circular floating "Give feedback" button. Native <button> gives us
 * Enter/Space activation and focusability for free; we only wire the click.
 */
import type { Runtime } from "../index";

const BUBBLE =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path fill="currentColor" d="M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-4 4v-4H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/>' +
  "</svg>";

export function createTrigger(rt: Runtime): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "trigger pos-" + rt.cfg.position;
  b.setAttribute("aria-label", "Give feedback");
  b.innerHTML = BUBBLE;
  b.addEventListener("click", () => rt.overlay.enter());
  return b;
}
