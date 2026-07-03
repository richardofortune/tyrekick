# Tyrekick — Build Contract (single source of truth)

> **Internal document** — this is the build contract for agents/contributors working
> **on** Tyrekick, kept as a running spec with dated addenda. If you want to *use*
> Tyrekick, read [README.md](README.md) (humans) or [AGENTS.md](AGENTS.md) (agents).

This is a **greenfield build**. There is no existing code to search; build against
this contract. `src/types.ts` holds the canonical TypeScript types — import from it.

## What this is
An embeddable, zero-backend comment overlay for web prototypes. A "Give feedback"
button lets a reviewer click a point on the page, type a comment, and submit. The
library POSTs a JSON payload to a webhook URL the builder owns (Discord webhook, a
same-origin serverless function, or any CORS-enabled endpoint). No Frontier Ops
backend, no accounts, nothing phones home.

> Design change from the original spec: we NO LONGER target the Claude-artifact
> sandbox. Builders host the prototype on a normal origin. Therefore:
> - `localStorage` is ALLOWED (draft recovery + persistent session pins), gated by `persist`.
> - There is NO `fl.inline.js` build. Only `dist/tyrekick.js` (IIFE) and `dist/tyrekick.esm.js` (ESM).
> - The Google Apps Script destination is REPLACED by Discord (default) + a
>   TypeScript Cloudflare template.

## Public API
- Global (IIFE build): `window.Tyrekick.init(config)` / `.destroy()`.
- ESM: `import { init, destroy } from "tyrekick"`.
- `init()` twice without `destroy()` → no-op + `console.warn`.
- Missing `webhook` or `appVersion` → `throw new Error(...)` with a clear message.
- `destroy()` removes all DOM, listeners, and in-memory state.

## Config (see `src/types.ts` TyrekickConfig)
webhook (req), appVersion (req), projectName (=document.title), position
("bottom-right"), accent ("#4f46e5"), branding (true), fields ({name:true}),
transport ("json" | "discord", default "json"), persist (true).

## data-* auto-init (IIFE only, from the script's own tag)
`data-webhook`, `data-app-version`, `data-project-name`, `data-transport`,
`data-accent`, `data-position`, `data-branding`. Auto-init on DOMContentLoaded
(or immediately if already loaded). Read attributes from `document.currentScript`.

## Payload — schema v2 (2026-07-03; src/types.ts is canonical)
v2 adds the agent source-mapping layer: `anchor.element` (tag/id/testid/role/
visible text ≤80/label/rect — text is the greppable bridge from rendered DOM to
source; NEVER capture input values), `anchor.context` (nearest heading text +
landmark path ≤3 segments), env extensions (screen, dpr, dark, touch), and
`page_errors` (last ≤5 uncaught errors/rejections via window listeners — console is
never patched; gated by config `captureErrors`, default true). The worker accepts
schema 1 or 2 (widget only ever sends 2). All element/context capture must never
throw — null on any failure.

## Payload (see `src/types.ts` FeedbackPayload) — schema v1 notes (historical)
- `x_pct`/`y_pct` = percentage of DOCUMENT dims (documentElement.scrollWidth/Height)
  at click time, 1 decimal place.
- Selector: deepest HOST element at the point, max 5 segments, never throws (null on
  error). CRITICAL: the crosshair capture layer intercepts the click, so
  `document.elementFromPoint` would return the widget. Compute the selector with the
  capture layer set to `pointer-events:none` (or via `elementsFromPoint` skipping any
  node inside the widget host). A unit test asserts the selector is never the widget.
- `session_id`: one `crypto.randomUUID()` per page load. Provide a non-secure-context
  fallback UUID generator so it never throws.

## Transport (`transport/webhook.ts`)
- POST, 8s timeout (AbortController), 1 automatic retry after 2s backoff.
- transport "json": `Content-Type: application/json`, body = payload JSON. Success =
  HTTP 2xx AND (no body OR body is not `{"ok":false}`).
- transport "discord": POST `{ content: string }` as JSON to the webhook. Success =
  HTTP 2xx (Discord = 204). Format a readable message, e.g.:
  `**{project} {version}** — {reviewer|Anonymous}\n{body}\n{anchor} · <{url}>`.
- On final failure (timeout/network/non-2xx/`ok:false`): surface a failure result so
  the panel can show "Couldn't send. Copy your comment?" with copy-to-clipboard.

## Behaviour (UI)
- Everything renders inside ONE Shadow DOM root on a single host element. Never mutate
  host-page styles/DOM. z-index 2147483000.
- Trigger: 48px circular button, configured corner, inline speech-bubble SVG,
  `aria-label="Give feedback"`, keyboard focusable (Enter/Space).
- Comment mode: full-viewport transparent capture layer inside the shadow root gives a
  crosshair cursor; dismissible hint bar "Click anywhere to leave a comment — Esc to
  cancel". Click/tap → numbered pin at the point + composer opens anchored near it
  (flips to stay in viewport). Touch events must work (mobile).
- Composer: multiline textarea (required, max 2000 chars, live counter), optional name
  input (if fields.name), Submit + Cancel, branding footer. `role="dialog"`, focus
  trap, focus returns to trigger on close. Esc/Cancel exits composer; Esc again exits
  comment mode.
- Submit: inline spinner → success "✓ Sent — thank you" 1.5s then close, pin solid.
  Failure → retry → "Couldn't send. Copy your comment?" + Copy button, pin red.
- Pins from THIS session stay visible in comment mode, numbered in submission order.
  With `persist:true`, restore this session's pins + any unsent draft after reload.
- Comment drawer: once ≥1 comment is submitted, a small "View comments" toggle (38px,
  count badge) appears above the trigger. It opens a right-hand drawer
  (`role="complementary"`, 320px, max 85vw) listing each comment: pin number badge
  (accent = sent, red = failed), text, reviewer/time/"not sent" meta. Clicking an
  entry smooth-scrolls the page to the pin and pulses it; pins are shown while the
  drawer is open. Esc or Close dismisses it (focus returns to the toggle). Pins
  store `body`/`reviewer`/`at` and these persist with `persist:true`.
- Branding footer: text "Built by Frontier Operations" linking
  `https://frontierops.dev` (target=_blank rel=noopener), small; hidden if
  `branding:false`.

## Accessibility / quality bar
Keyboard-operable, visible focus rings, contrast ≥ 4.5:1, no console errors or
unhandled rejections in ANY flow (including webhook failure), never scroll-lock or
reflow the host page.

## Build
`node build.mjs` → `dist/tyrekick.js` (IIFE, global Tyrekick, auto-init) + `dist/tyrekick.esm.js`.
IIFE entry = `src/auto.ts` (re-exports init/destroy from index.ts AND runs auto-init).
ESM entry = `src/index.ts` (exports init/destroy, NO auto-init). Budget: tyrekick.js ≤ 30KB gz.

## MCP loop (addendum, 2026-07-03) — feedback must be PULLABLE, not just collectable

### Worker REST surface (destinations/cloudflare/worker.ts)
The worker keeps its open ingest and grows a token-gated management face:

- **POST /feedback** (and POST / for back-compat): ingest, UNAUTHENTICATED (reviewers
  stay frictionless). Validation as before (schema===1, non-empty body, truncate >2000).
  Stored record = the FeedbackPayload PLUS server fields:
  `{ status: "open", received_at: <ISO>, resolved_at: null, resolution_note: null }`.
- **GET /feedback?status=&route=&since=&limit=** — list records, newest first.
  `status` = open|resolved, `since` = ISO timestamp, `limit` default 50 max 200.
- **GET /feedback/:id** — full single record.
- **PATCH /feedback/:id** — body `{ status: "resolved"|"open", note?: string }`;
  sets resolved_at/resolution_note; returns the updated record.
- **Auth:** GET/PATCH require `Authorization: Bearer <TYREKICK_TOKEN>` where the
  token is a wrangler secret (`wrangler secret put TYREKICK_TOKEN`). Missing/wrong
  token → 401 `{"ok":false,"error":"unauthorized"}`. POST needs no auth.
- **KV layout:** key `fb:<payload.id>`, value = full record JSON, KV **metadata**
  `{ t: created_at, s: status, r: route }` so list/filter reads metadata only and
  fetches bodies just for the returned page. (KV list caps at 1000 — fine for
  prototype scale; D1 is the upgrade path, not now.)
- All responses JSON `{"ok":true,...}` / `{"ok":false,"error":...}`; CORS headers as
  before on ingest; management routes are server-to-server (CORS optional).

### MCP server (mcp/ — new npm package tyrekick-mcp)
Stdio MCP server (TypeScript, Node ≥18, @modelcontextprotocol/sdk) that translates
MCP tool calls into the REST surface above. Config via env:
`TYREKICK_URL` (worker base URL), `TYREKICK_TOKEN`.

Tools (names + behaviour are the contract):
- `list_feedback { status?, route?, since?, limit? }` → summaries: id, created_at,
  status, route, body, reviewer_name, anchor.selector, app_version.
- `get_feedback { id }` → the full record incl. anchor + env.
- `resolve_feedback { id, note? }` → PATCH status=resolved; confirm result.
- `feedback_stats {}` → counts by status, by route, by app_version.

Requirements: bin entry `tyrekick-mcp` so `npx tyrekick-mcp` works;
clear startup error if env vars missing; 401 → actionable message ("check
TYREKICK_TOKEN"); network errors surfaced as tool errors, never crashes. README shows
`claude mcp add tyrekick --env TYREKICK_URL=... --env TYREKICK_TOKEN=... -- npx tyrekick-mcp`
and the fix-the-feedback workflow. The package is self-contained (own package.json,
tsconfig, build); runtime deps: @modelcontextprotocol/sdk (+ zod if the SDK needs it),
nothing else.

## Triage & review modes (addendum, 2026-07-03)
Status ladder: `open` (untriaged) → `approved` | `declined` → `resolved`.
- Worker PATCH accepts all four; resolved/declined set resolved_at (+ note);
  approved keeps resolved_at null (note kept if given); open clears both.
  List ?status= accepts all four.
- MCP adds `triage_feedback { id, status: approved|declined, note? }`.
- MODES are policy, not config (no reviewer auth exists): self-review = owner's
  own pins, agents may action `open` directly; shared review (default when
  unsure) = agents action `approved` only and offer conversational triage.
  Policy lives in AGENTS.md; the widget is unchanged and reviewers never see
  triage state.

## File ownership (do not touch files outside your lane)
- Core library agent: `src/**` (index.ts, auto.ts, ui/*, capture/*, transport/*).
- Destinations agent: `destinations/**`.
- Demo + docs agent: `demo/**`, root `README.md`.
- Tests agent: `test/**`, `playwright.config.ts`, `vitest.config.ts`.
- DO NOT modify: `package.json`, `tsconfig.json`, `build.mjs`, `src/types.ts`, `LICENSE`.
