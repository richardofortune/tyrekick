> **Archived.** This is the original pre-build spec (Google Sheets destination, Claude-artifact target — both since replaced). Current truth: /CONTRACT.md and /README.md.


# Project Spec: Prototype Feedback Overlay (Community Edition)

**Working name:** `feedback-layer` (final name TBD — pick before repo creation)
**Owner:** Richard, Frontier Operations Limited
**Licence:** MIT
**Purpose:** Open-source, zero-backend comment overlay for AI-built web prototypes. Feedback goes directly to a destination the builder owns (Google Sheet via Apps Script webhook). Brand vehicle for Frontier Ops, not a commercial product.
**Audience for this document:** Coding agents. Every requirement is written to be testable. Do not add features not listed here.

---

## 1. One-paragraph summary

A single embeddable JavaScript file that adds a "Give feedback" button to any web page. Clicking it enters comment mode: the reviewer clicks anywhere on the page, types a comment, and submits. The library POSTs a structured JSON payload to a webhook URL the builder configured (a Google Apps Script endpoint writing to their own Sheet). There is no server, no account, no database, and no data passes through Frontier Ops. The repo also ships the Apps Script template, a demo app, and documentation.

## 2. Hard constraints (violating any of these fails the build)

1. **No backend.** The deliverable is static: a JS bundle, an Apps Script template, docs, and a demo. Nothing to deploy or host except via CDN (jsDelivr from the GitHub repo/npm).
2. **Vanilla JS + Shadow DOM.** No React/Vue/framework dependency. All UI rendered inside a Shadow DOM root attached to a single host element, so host-page CSS cannot break the widget and vice versa.
3. **Bundle budget:** core bundle ≤ 30 KB gzipped. No runtime dependencies. Build-time devDependencies are fine (esbuild recommended).
4. **No storage APIs.** Do not use `localStorage`, `sessionStorage`, `IndexedDB`, or cookies anywhere. All state in memory. (Required for Claude artifact compatibility.)
5. **Two distribution forms from one source:**
   - `dist/fl.js` — IIFE bundle for `<script>` tag / CDN use, auto-initialises from `data-*` attributes.
   - `dist/fl.inline.js` — same bundle formatted for copy-paste inline into a `<script>` block, initialised by calling `FeedbackLayer.init(config)` (for hosts that block third-party script loading, e.g. Claude artifacts).
   - Also publish `dist/fl.esm.js` for `import { init } from ...`.
6. **Browser support:** last 2 versions of Chrome, Firefox, Safari, Edge. Mobile Safari and Chrome Android must work (touch events for pinning).
7. **MIT licence file present; no telemetry, no phoning home, no analytics of any kind in the library.**
8. **Branding:** the widget panel footer shows the text "Built by Frontier Operations" linking to `https://frontierops.dev`, small and unobtrusive. A config option `branding: false` hides it. Default is on.

## 3. Repository layout

```
feedback-layer/
├── src/
│   ├── index.js            # public API: init(), destroy()
│   ├── ui/
│   │   ├── trigger.js      # floating button
│   │   ├── overlay.js      # comment mode: capture layer, pins
│   │   ├── panel.js        # comment composer + confirmation states
│   │   └── styles.js       # CSS-in-JS string injected into shadow root
│   ├── capture/
│   │   ├── anchor.js       # click position → {x_pct, y_pct, selector}
│   │   └── context.js      # env capture: UA, viewport, route, timestamp
│   └── transport/
│       └── webhook.js      # POST with retry (1 retry, 2s backoff), timeout 8s
├── destinations/
│   └── google-sheets/
│       ├── Code.gs         # Apps Script template (see §6)
│       └── README.md       # step-by-step builder setup with screenshots
├── demo/
│   └── index.html          # self-contained demo app (see §8)
├── test/                   # vitest + jsdom unit tests; playwright e2e
├── dist/                   # built artefacts (committed on release tags only)
├── README.md               # see §9
├── LICENSE                 # MIT
└── package.json            # name, exports map, build + test scripts
```

## 4. Public API

### 4.1 Script-tag form

```html
<script src="https://cdn.jsdelivr.net/gh/ORG/feedback-layer@1/dist/fl.js"
        data-webhook="https://script.google.com/macros/s/XXX/exec"
        data-app-version="0.3.2"
        data-project-name="My Prototype"></script>
```

Auto-initialises on `DOMContentLoaded` (or immediately if DOM already loaded) reading `data-*` attributes from its own script tag.

### 4.2 Programmatic form

```js
FeedbackLayer.init({
  webhook: "https://script.google.com/macros/s/XXX/exec",  // required
  appVersion: "0.3.2",                                      // required
  projectName: "My Prototype",                              // optional, default document.title
  position: "bottom-right",   // bottom-right | bottom-left, default bottom-right
  accent: "#4f46e5",          // trigger/pin colour, default #4f46e5
  branding: true,             // default true
  fields: { name: true }      // show optional reviewer-name input, default true
});
FeedbackLayer.destroy();       // removes all DOM, listeners, state
```

`init()` called twice without `destroy()` is a no-op with a `console.warn`. Missing `webhook` or `appVersion` throws with a clear message.

## 5. Behaviour specification

### 5.1 Trigger button
- Fixed-position circular button (48px), configured corner, z-index 2147483000, inside shadow root.
- Label: speech-bubble icon (inline SVG, no icon font). `aria-label="Give feedback"`. Keyboard focusable, activates on Enter/Space.

### 5.2 Comment mode
- Clicking trigger toggles comment mode. In comment mode:
  - Cursor over host page becomes crosshair (applied via a full-viewport transparent capture layer inside the shadow root — do not mutate host DOM styles).
  - A dismissible hint bar at top: "Click anywhere to leave a comment — Esc to cancel".
  - Reviewer clicks/taps a point → a numbered pin renders at that point and the composer panel opens anchored near it (flipping to stay in viewport).
- Composer panel contains: multiline text area (required, max 2000 chars, counter shown), optional name input (if `fields.name`), Submit and Cancel buttons, branding footer.
- Esc or Cancel exits composer; Esc again exits comment mode. Pins from feedback already submitted *this session* remain visible in comment mode, numbered in submission order; they are not persisted across reloads (no storage — by design).

### 5.3 Submission
- On Submit: panel shows inline spinner; POST payload (§5.4) to webhook as `text/plain` body containing JSON (see §6 for why not `application/json`).
- Success (HTTP 200 and response body `{"ok":true}`): panel swaps to "✓ Sent — thank you" for 1.5s, then closes; pin turns solid.
- Failure (network error, timeout 8s, non-200, or malformed response): one automatic retry after 2s. If still failing: panel shows "Couldn't send. Copy your comment?" with a Copy-to-clipboard button so the reviewer's text is never lost. Pin turns red.

### 5.4 Payload schema (v1 — do not extend without version bump)

```json
{
  "schema": 1,
  "id": "<crypto.randomUUID()>",
  "created_at": "<ISO-8601 with timezone>",
  "project_name": "My Prototype",
  "app_version": "0.3.2",
  "route": "<location.pathname + search + hash>",
  "url": "<location.href>",
  "body": "<comment text, trimmed>",
  "reviewer_name": "<string or null>",
  "session_id": "<crypto.randomUUID(), generated once per page load>",
  "anchor": {
    "x_pct": 42.1,
    "y_pct": 63.0,
    "selector": "<best-effort CSS selector of deepest host element at point, max 5 segments, or null>",
    "viewport": { "w": 390, "h": 844 }
  },
  "env": { "user_agent": "<navigator.userAgent>", "language": "<navigator.language>" }
}
```

`x_pct`/`y_pct` are percentages of document (not viewport) dimensions at click time, 1 decimal place. Selector generation must never throw; on any error, `null`.

### 5.5 Explicitly not included (do not build)
Screenshots, video, session replay, threaded replies, reading existing feedback back into the widget, any persistence, any auth, any second destination in v1 (Notion cannot be called from a browser due to CORS; note this in README as a known limitation with a "run your own proxy" pointer — do not build the proxy).

## 6. Google Sheets destination (`destinations/google-sheets/Code.gs`)

Apps Script web app the builder deploys to their own Google account. Requirements:

- `doPost(e)` parses `e.postData.contents` as JSON. (Library sends `text/plain` specifically to avoid a CORS preflight, which Apps Script web apps do not handle. Document this in a code comment.)
- On first write, if the sheet has no header row, write header: `Timestamp | Version | Route | Reviewer | Comment | Anchor | Session | URL | ID`.
- Append one row per payload. `Anchor` column format: `x%,y% selector` e.g. `42.1%,63.0% #export-btn`.
- Reject payloads where `schema !== 1` or `body` is empty → `{"ok":false,"error":"..."}` with HTTP 200 (Apps Script cannot set status codes reliably; the library treats `ok:false` as failure).
- Basic abuse guard: if `body.length > 2000`, truncate and append `…`.
- Response is always JSON: `{"ok":true}` on success.
- The README in that folder must be a numbered nontechnical walkthrough: create Sheet → Extensions → Apps Script → paste → Deploy → Web app → "Anyone" access → copy URL → paste into snippet. Include a troubleshooting section (common failure: deployed with wrong access level).

## 7. Accessibility & quality bar

- All interactive elements keyboard-operable; visible focus rings; `role="dialog"` + focus trap on the composer; focus returns to trigger on close.
- Colour contrast ≥ 4.5:1 for text in the widget's default theme.
- No console errors or unhandled rejections in any flow, including webhook failure.
- Widget must not scroll-lock, resize, or reflow the host page at any time.

## 8. Demo app (`demo/index.html`)

Self-contained single HTML file styled to look like a plausible AI-built prototype (a small fictional "trip planner" with a few buttons and a form — static, no real logic). Loads the library from `../dist/fl.js` with a placeholder webhook and a `?webhook=` query-param override so a builder can test against their real Apps Script in one step. Banner at top: "Demo — feedback below goes to the sheet you configured."

## 9. README requirements

Sections, in order: what it is (2 sentences) · 60-second quickstart (Sheet setup then snippet) · Claude artifact / inline install instructions · configuration table · payload schema · limitations (no persistence, no Notion, single destination) · contributing · "Built by [Frontier Operations](https://frontierops.dev)" section with one paragraph on why this exists. Include a GIF of the flow (record from the demo app).

## 10. Testing & acceptance criteria

Unit (vitest + jsdom): payload construction matches §5.4 exactly (snapshot); anchor math on a mocked document; selector generator never throws on pathological DOM; init/destroy idempotency; data-attribute parsing.

E2E (Playwright, against `demo/index.html` with a mocked webhook route):
1. Trigger visible; comment mode entered; click at a point; composer opens; submit → mocked webhook receives payload with correct `x_pct`/`y_pct` (±0.5) and non-empty `body`; success state shown.
2. Webhook returns 500 twice → retry occurs → failure state with working copy-to-clipboard.
3. Esc behaviour and focus-trap behaviour per §5.2/§7.
4. Mobile viewport (390×844): tap-to-pin works; composer fully visible.
5. Bundle-size check in CI: fail if `dist/fl.js` gzipped > 30720 bytes.

Manual acceptance (human, pre-release): paste `fl.inline.js` into a Claude artifact and complete one real submission to a real Google Sheet. This is the definition of done for v1.0.0.

## 11. Build & release

- esbuild; targets per §2.6; three outputs per §2.5; `npm run build`, `npm test`, `npm run e2e`.
- GitHub Actions: test + size check on PR; on tag `v*`, build, attach dist to release, publish to npm.
- Version 1.0.0 only after §10 manual acceptance passes.

## 12. Suggested agent task breakdown

1. Scaffold repo, build pipeline, empty API surface, CI (§3, §11)
2. Trigger + comment mode + composer UI in Shadow DOM (§5.1–5.2, §7)
3. Anchor + context capture + payload assembly (§5.4) with unit tests
4. Webhook transport with retry/failure/copy flow (§5.3)
5. Apps Script template + destination README (§6)
6. Demo app (§8) + Playwright suite (§10)
7. README + inline-install docs (§9), release v1.0.0 after manual acceptance
