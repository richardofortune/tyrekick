# Configuration

Every option, its default, and how to set it in each build. `src/types.ts`
(`TyrekickConfig`) is the canonical contract.

## The two builds

- **IIFE / auto-init** (`dist/tyrekick.js`, the jsdelivr script tag): reads
  `data-*` attributes from its own `<script>` tag and initialises on
  `DOMContentLoaded` (or immediately if the page is already loaded). Also
  exposes `window.Tyrekick.init()` / `.destroy()`.
- **ESM** (`dist/tyrekick.esm.js`, via `npm install tyrekick`): exports
  `init(config)` / `destroy()`; never auto-initialises.

Calling `init()` twice without `destroy()` is a no-op with a console warning.
A missing `webhook` or `appVersion` throws.

## All options

| Config field | `data-*` attribute | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| `webhook` | `data-webhook` | `string` | — **required** | Destination URL that receives the POST. Visible in page source by design — see [Destinations](destinations.md) for when that matters. |
| `appVersion` | `data-app-version` | `string` | — **required** | Version of the build under review. Convention: git short SHA. |
| `projectName` | `data-project-name` | `string` | `document.title` | **Set this explicitly, once, as a stable kebab-case slug.** It's the project's durable identity across redeploys; the `document.title` fallback forks your feedback stream when a title changes. |
| `position` | `data-position` | `"bottom-right" \| "bottom-left"` | `"bottom-right"` | Corner for the trigger button (and the drawer toggle above it). |
| `accent` | `data-accent` | `string` | `"#FFC53D"` | Colour for the trigger, pin badges, and Send button. Text on the accent auto-contrasts: light accents get dark ink, dark accents get white. |
| `theme` | `data-theme` | `"auto" \| "light" \| "dark"` | `"auto"` | `"auto"` follows the visitor's `prefers-color-scheme` live; `"light"`/`"dark"` pin it. Host-page styles are never touched. |
| `branding` | `data-branding="false"` | `boolean` | `true` | The "Built by Frontier Operations" footer in the composer. |
| `fields` | *(ESM only)* | `{ name?: boolean }` | `{ name: true }` | `{ name: false }` removes the optional reviewer-name input. |
| `transport` | `data-transport` | `"json" \| "discord"` | `"json"` | `"json"` POSTs the raw [schema-v2 payload](payload.md); `"discord"` formats it into a webhook message. |
| `persist` | *(ESM only)* | `boolean` | `true` | localStorage is used **only for unsent recovery**: draft text and failed comments awaiting retry after a reload. Successfully sent comments are never stored. `false` = no storage keys are ever read or written. |
| `reviewKey` | `data-review-key` | `string` | *(off)* | **Shared review**: every reviewer sees every other reviewer's pins, read-only and attributed. Must match `TYREKICK_REVIEW_KEY` on your Worker (worker transport only). The key is in your page source, so **anyone with the review link can read every comment on the project, including reviewer names** — right for a private link, wrong for a public URL. Rotate the secret to revoke. See [destinations](destinations.md#shared-review). |
| `captureErrors` | `data-capture-errors="false"` | `boolean` | `true` | Attach the page's last ≤5 uncaught errors/unhandled rejections to each payload as `page_errors` (via `window` listeners — the console is never patched). Input **values** are never captured regardless of this flag. |

`persist` and `fields` have no `data-*` equivalent — use the ESM build (or
`window.Tyrekick.init()` with a config object) if you need to change them.

## Worker-side secrets (not part of `TyrekickConfig`)

Some destination behaviour is configured on the worker itself, not the
widget, and has no `data-*` attribute at all — it belongs in the
[destination/worker config](../destinations/cloudflare), not here:

- `TYREKICK_TOKEN` — management-route auth for the MCP/REST loop.
- `TYREKICK_REVIEW_KEY` — the server-side counterpart of `reviewKey` above.
- `ANTHROPIC_API_KEY` — optional; turns on a one-line AI acknowledgement per
  comment (Haiku, no tools, author-only, pin stays open). Unset = feature
  off. See [CONTRACT.md](../CONTRACT.md) for the guardrails.

## Delivery behaviour (both transports)

Every submission POSTs with an 8-second timeout and exactly one automatic
retry after a 2-second backoff. Failures never throw and never surface as
console errors; the composer shows a failure state with **Retry** and
**Copy your comment**, and (with `persist: true`) the failed comment survives
reloads with Retry/Discard available from the drawer.

- `transport: "json"` — success is HTTP 2xx and, if a body is returned, it is
  not `{"ok":false}`.
- `transport: "discord"` — success is HTTP 2xx (Discord returns 204).

## Isolation guarantees

Everything renders inside one Shadow DOM root on a single host element
appended to `<body>`. Tyrekick never mutates host-page DOM or styles, never
scroll-locks, and never reflows your page. Widget z-index is 2147483000.

## Version pinning

`tyrekick@latest` on jsdelivr tracks the newest release. For a build you never
want to shift underneath you, pin it:

```
https://cdn.jsdelivr.net/npm/tyrekick@0.3.0/dist/tyrekick.js
```
