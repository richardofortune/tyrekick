/**
 * Tyrekick — public types. This file is the contract every module and
 * template builds against. Do not change field names without a schema bump.
 */

export type Position = "bottom-right" | "bottom-left";
export type Transport = "json" | "discord";

export interface TyrekickConfig {
  /** Destination URL that receives the POST. Required. */
  webhook: string;
  /** Version string of the prototype under review. Required. */
  appVersion: string;
  /** Human label for the project. Default: document.title */
  projectName?: string;
  /** Trigger button corner. Default: "bottom-right" */
  position?: Position;
  /** Trigger + pin colour. Default: "#4f46e5" */
  accent?: string;
  /** Show the "Built by Frontier Operations" footer. Default: true */
  branding?: boolean;
  /** Optional reviewer-name input. Default: { name: true } */
  fields?: { name?: boolean };
  /**
   * How the payload is delivered.
   *  - "json"    (default): POST the raw JSON payload (§ Payload). For a
   *              same-origin function, a CORS-enabled endpoint, or a form
   *              backend. Success = HTTP 2xx and, if a body is returned,
   *              it is not `{"ok":false}`.
   *  - "discord": map the payload to a Discord webhook message
   *              ({ content }) and POST that. Success = HTTP 2xx (Discord
   *              returns 204). Cross-origin friendly.
   */
  transport?: Transport;
  /**
   * Use localStorage for draft recovery (restore unsent text after a failed
   * submit) and to keep this session's pins across reloads. Default: true.
   * No storage keys are read/written when false.
   */
  persist?: boolean;
  /**
   * Record the page's uncaught errors / unhandled rejections (via window
   * "error" and "unhandledrejection" listeners — console is never patched)
   * and attach the last few to each payload as `page_errors`. Default: true.
   * Input VALUES are never captured anywhere, regardless of this flag.
   */
  captureErrors?: boolean;
}

/**
 * Payload schema v2 — do not extend without bumping `schema`.
 * v2 adds the source-mapping layer so a coding agent can act on feedback:
 * element identity/text (greppable in source), structural context (nearest
 * heading + landmark), richer env, and recent page errors.
 */
export interface FeedbackPayload {
  schema: 2;
  /** crypto.randomUUID() per comment */
  id: string;
  /** ISO-8601 with timezone */
  created_at: string;
  project_name: string;
  app_version: string;
  /** location.pathname + search + hash */
  route: string;
  /** location.href */
  url: string;
  /** comment text, trimmed */
  body: string;
  reviewer_name: string | null;
  /** crypto.randomUUID(), generated once per page load */
  session_id: string;
  anchor: {
    /** percentage of document width at click time, 1 decimal */
    x_pct: number;
    /** percentage of document height at click time, 1 decimal */
    y_pct: number;
    /** best-effort CSS selector of the deepest HOST element at the point,
     *  max 5 segments, or null. Must never be the widget's own nodes. */
    selector: string | null;
    viewport: { w: number; h: number };
    /** The host element under the click. null only if none could be resolved.
     *  For <input>/<textarea>/<select>, `text` is always null (values are
     *  never captured); `label` may carry placeholder/aria-label. */
    element: {
      /** lowercase tag name, e.g. "button" */
      tag: string;
      id: string | null;
      /** data-testid attribute if present */
      testid: string | null;
      role: string | null;
      /** visible text (innerText), trimmed, ≤80 chars, or null */
      text: string | null;
      /** aria-label || alt || placeholder || title, ≤80 chars, or null */
      label: string | null;
      /** viewport-relative bounding rect at click time, integer px */
      rect: { x: number; y: number; w: number; h: number };
    } | null;
    /** Where in the page structure the click landed. */
    context: {
      /** text of the nearest ancestor-or-preceding heading (h1–h6), ≤80 chars */
      heading: string | null;
      /** coarse landmark path, e.g. "main > section#pricing" (≤3 segments) */
      landmark: string | null;
    };
  };
  env: {
    user_agent: string;
    language: string;
    /** physical screen, CSS px */
    screen: { w: number; h: number };
    /** window.devicePixelRatio, 2 decimals */
    dpr: number;
    /** prefers-color-scheme: dark */
    dark: boolean;
    /** primary input is touch (pointer: coarse) */
    touch: boolean;
  };
  /** Last ≤5 uncaught errors/unhandled rejections seen this page load, each
   *  ≤200 chars, oldest first. [] when none or captureErrors:false. */
  page_errors: string[];
}

export interface TyrekickApi {
  init(config: TyrekickConfig): void;
  destroy(): void;
}
