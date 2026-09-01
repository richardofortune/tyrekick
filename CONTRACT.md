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
> - `localStorage` is ALLOWED for unsent recovery (drafts + failed comments awaiting
>   retry) and — worker transport only — delivered-comment receipts (so closure can
>   reach the reviewer). Both gated by `persist`. Never a shadow database of sent
>   content beyond the capped receipts window.
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
webhook (req), appVersion (req), projectName (=document.title; installers must
set a stable slug — see the identity addendum), position ("bottom-right"),
accent ("#FFC53D", auto-contrast ink), theme ("auto" | "light" | "dark",
default "auto"), branding (true), fields ({name:true}), transport ("json" |
"discord", default "json"), persist (true), captureErrors (true).

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
  HTTP 2xx AND (no body OR body is not `{"ok":false}`). A failure response whose
  JSON body carries a string `error` propagates that string to the caller as
  `SendResult.error`, so the body is read on the failure path too (read it only
  on 2xx and the reason can never reach the UI). `error: "review_closed"`
  suppresses the retry, because a closed review is a deterministic refusal and
  retrying only makes the reviewer wait 2s to be told no twice. No other value,
  and no untyped failure, changes retry behaviour.
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
  trap, focus returns to trigger on close. Cmd/Ctrl+Enter submits. Esc closes the
  composer but KEEPS the typed draft (Cancel is the destructive path and clears it);
  Esc again exits comment mode. Reply composers (drawer follow-ups) show a
  "Replying to #N" chip instead of the anchor chip; the "Re #N:" linkage prefix is
  added to the payload at send time, never shown as editable text. While a reply
  composer is open its root pin is highlighted (accent ring) so the thread's
  subject stays visible on the page.
- Submit: inline spinner → success "✓ Sent — thank you" 1.5s then close, pin solid.
  Failure → retry → "Couldn't send. Copy your comment?" + Copy button, pin red.
  A `review_closed` refusal skips the retry and reads "This review has closed —
  your comment wasn't sent." with the Copy button beside it and the send button
  DISABLED, since there is nothing to retry against. The pin still goes red and
  the draft is still saved, exactly as on any other failure, so the text is never
  lost. A restored failed pin's drawer Retry button reads "Review closed" and
  stays disabled rather than offering a retry that cannot succeed.
- Pins are first-class interactive objects, numbered in submission order. They
  render whenever any exist — dimmed while the widget is idle, full strength
  while comment mode / composer / drawer is engaged — because they are the
  reviewer's marks, not mode UI. Submitted pins are buttons (~36px hit target
  around the 24px reticle): hover/focus shows the comment text in a tooltip,
  click opens a thread popover at the pin (same entries and Retry/Discard/
  Follow up actions as the drawer). Pending pins are inert (the composer is
  their interface). A "Hide pins" toggle in the drawer header suppresses them
  (comment mode overrides while active). Scroll/resize tracking is owned by the
  overlay and tied to pin visibility, so a visible pin never freezes or drifts.
  With `persist:true`, restore unsent work only after reload: failed comments/pins
  plus any unsent draft text. Successfully submitted comments are not restored
  from localStorage. Pins re-attach to their anchor element (selector + stored
  in-element click fraction) on restore and on window resize, so they follow the
  content across viewport/layout changes; raw document coordinates are the
  fallback when the selector no longer resolves.
- Comment drawer: once ≥1 comment is submitted, a small "View comments" toggle (38px,
  count badge) appears above the trigger. It opens a right-hand drawer
  (`role="complementary"`, 320px, max 85vw) listing each comment: pin number badge
  (accent = sent, red = failed), text, reviewer/time/"not sent" meta. Clicking an
  entry smooth-scrolls the page to the pin and pulses it; locating a pin the
  drawer itself would cover closes the drawer first (pins stay on the page).
  Esc or Close dismisses it (focus returns to the toggle). Opening a pin's
  thread popover closes the drawer and vice versa. Pins store
  `body`/`reviewer`/`at`; only failed comments persist with `persist:true`.
  Failed entries carry Retry (resends with the original written-at timestamp) and
  Discard actions — the unsent-work loop must be closable after a reload, not only
  at the moment of failure. The toggle's count badge turns red while any comment
  is unsent.
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
  Gated by the review window (see the review-window addendum): once
  `TYREKICK_OPEN_UNTIL` has passed, both routes answer **403**
  `{"ok":false,"error":"review_closed","open_until":"<the configured instant>"}`
  with CORS headers, before the body is read, so a closed review parses nothing,
  stores nothing and tees nothing. The guard is the first statement of
  `handleIngest`, never the router, so it covers both routes and any future
  third; the ingest rate limiter still runs ahead of it, because a closed review
  must not be a free unmetered endpoint.
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

## Receipts — closure reaches the reviewer (addendum, 2026-07-05)

The loop's missing half: the reviewer who pinned a comment learns what
happened to it. Worker transport only (Discord is write-only by design).

- **Worker**: `GET /receipts?ids=<uuid>,…` is UNAUTHENTICATED. Payload ids are
  unguessable UUIDv4 capabilities known only to the submitting browser and the
  store; exact-id lookups only, batch hard-capped at 50, unknown ids silently
  omitted (no existence oracle), response carries only
  `{id, status, resolved_at, resolution_note}` per hit. The response envelope
  also carries `review: {state, open_until}` on both return sites, including the
  empty-`ids` early return, which is how the CLI reads a deployment's window
  without a token; the per-receipt projection is unchanged, and readers ignore
  unknown keys. PATCH additionally mirrors
  resolved/declined transitions to `DISCORD_WEBHOOK` when set (best-effort,
  waitUntil, failures swallowed).
- **Widget**: on successful delivery, `Pin.deliveredId` = the payload id and a
  receipt record persists to `tyrekick:receipts:<pathname>` (persist-gated,
  `transport:"json"` only; ≤50 records, ≤14 days, pruned on save). On restore,
  receipts return as SENT pins (numbered with everything else, re-anchored like
  everything else). The widget polls /receipts for RESTORED ids on init and on
  drawer open, throttled to ≥60s, silent on every failure — a destination
  without the route simply never turns pins green, no console noise ever.
- **UI**: resolved → green badge (pin, drawer, popover) with the resolution
  note shown in the entry and appended to the hover tooltip; declined → neutral
  badge with its note. Closed root entries gain "Got it", which retires the
  whole thread (root + replies) from page and storage. Failed→retry success
  graduates a comment from the unsent store to the receipts store.

## Operating patterns & project identity (addendum, 2026-07-05)

Two documented patterns for the agent consuming feedback; they trade friction
for risk in opposite directions:

- **Passive monitor**: read-only. Poll list/stats, digest, optionally triage;
  never modify source. Positioning: a deliberately LIGHTER thing than an issue
  tracker — for ephemeral work, collecting and summarizing beats tracking.
  No tracker weight (boards/sprints/severity) is ever added to Tyrekick.
- **Active steward**: treats all actionable comments as work items — fix,
  redeploy, resolve. Risky by construction; the triage ladder is the brake:
  active over `open` only in self-review mode, otherwise `approved` only
  (policy lives in AGENTS.md, unchanged from the triage addendum).
- **Speculative steward** (added 2026-07-06): implement feedback on a PREVIEW
  deploy without asking — permission to try is free when builds are cheap; the
  human grants permission to KEEP by comparing before/after previews and
  answering keep-or-kill. Never lands on mainline without a keep, so it is
  permitted over `open` even in shared review — the preview IS the proposal.
  The approval object is a comparison of running software, not a ticket.
  Batching (N pins → one preview → one keep/kill session) protects the human
  attention that is now the loop's scarcest input.

**Project identity vs URL churn**: preview hosts mint a new origin per deploy,
and localStorage is per-origin, so neither the URL nor client storage can be
the thread of continuity. `project_name` IS the durable project identity
(worker filters by it; `p:` KV metadata). Consequences, now normative:
- Installers MUST set an explicit, stable, kebab-case `projectName` chosen once
  (the `document.title` fallback is a documented hazard: editing the title
  forks the feedback stream).
- After a redeploy that changes the URL, `resolve_feedback` notes MUST carry
  the new deploy URL + app version — the note is how humans follow the loop
  across the churn.
- Planned (not yet built): the per-project ingest key doubles as durable
  project identity — one primitive for webhook-abuse revocation, cross-deploy
  aggregation, and receipts continuity. Until then, `project_name` carries it.

**Retention rationale**: even for disposable builds, the feedback→fix→resolve
exchange is a learning corpus (cross-project patterns reported back to the
builder). Resolution notes are written to be minable; this is the long-term
steward-insights path and the reason resolved records keep their notes.

## Shared review — reviewers see each other (addendum, 2026-07-21)

Until now a review was N private conversations: "reviews are per-browser; two
reviewers each see their own pins, not each other's." Shared review makes the
page the shared surface, OPT-IN, without moving the destination or adding an
account anywhere.

- **Widget**: `reviewKey` (config) / `data-review-key` (auto-init). Unset =
  historic behaviour exactly, no new requests. Worker transport only.
- **Worker**: `GET /shared?project=&route=`, header
  `X-Tyrekick-Review-Key: <TYREKICK_REVIEW_KEY>`. The secret being unset =
  404 (an operator who never opted in does not advertise the route). Wrong key
  = 401. Missing `project` = 400 — project scope is MANDATORY so a key for one
  prototype cannot read another on the same worker.
- **The key is public by construction.** It ships inside the page, so anyone
  holding the review link can read every comment on that project. This is the
  documented trade: correct for a private link shared with people you trust,
  wrong for a public URL. Revocation = rotate the secret. It is deliberately
  NOT `TYREKICK_TOKEN`, which grants write/triage and must never reach a
  browser.
- **Projection is normative** (`sharedView`): one reviewer may learn another's
  `body`, `reviewer_name`, `created_at`, `route`, `app_version`, status/note
  and `anchor`. They may NEVER learn `env` (user-agent fingerprint),
  `page_errors` (the builder's stack traces), `url` (share-link query secrets)
  or `session_id` (correlates a person's comments). Adding a field to the
  payload does NOT add it here — extend `sharedView` deliberately or not at all.
- **`declined` is withheld from the shared view.** Declining is therefore how an
  owner removes spam/noise from *everyone's* page; the author still learns the
  outcome via `/receipts`, which is keyed by their own capability id.
- **Foreign pins are strictly read-only**: never persisted to localStorage
  (they live on the server and are re-fetched), never retried/discarded, no
  "Got it", and always attributed ("Another reviewer" when the name is blank).
  A foreign pin's local id IS its server id, so a local reply stays attached
  across reloads. Follow-up ON a foreign pin is allowed and is the "+1, me too"
  path — replies still travel to the destination, never peer-to-peer.
- **Numbering**: a comment's number is assigned by the destination, not counted
  by the reader. `/shared` derives it from the page's whole history ordered by
  `created_at` (`id` breaking ties) and returns it as `n`. The set it counts
  over **includes declined records**, so a removed comment leaves a gap and
  every surviving number stays put. Numbers are quoted — the widget freezes one
  into each `Re #N:` prefix, and reviewers write "see #4" to each other — so a
  gap is correct and a silent renumber is not.

  The widget prefers `n` when present and counts only what the destination has
  never seen: local-only and in-flight comments, numbered above every assigned
  number so the two schemes cannot collide. `n` is absent on the Discord
  transport and from workers older than 0.6, and the reader falls back to
  counting; a page mixing the two therefore still satisfies the uniqueness
  invariant but not stability. (This resolves the previously parked
  monotonic-numbering question for the worker destination.)

  Numbering is **not** exposed on `/receipts`. Deriving it needs a list over the
  project, and that route is contractually a non-listing capability lookup —
  see the receipts note above. A single reviewer with no review key therefore
  keeps historic insertion-order numbering.
- **Refresh posture**: silent on every failure like `/receipts`. Background
  polls (init, route change) are throttled at 60s; opening the drawer forces a
  fetch, guarded only by a single-in-flight lock — the first drawer open after
  load is exactly when "what did others say?" is asked.

**The line, deliberately not crossed**: this is a READ-ONLY view of other
reviewers. No live presence, no peer-to-peer threading, no conflict resolution
— comments still meet at the destination, not on the page. Concurrent
on-page conversation is how this becomes a collaboration product and acquires
the tracker weight the operating-patterns addendum forbids.

## AI auto-reply — an acknowledgement, not an agent (addendum, 2026-07-23)

On ingest, the worker can ask Claude Haiku for one short, friendly
acknowledgement of the comment and store it back on the record — a courtesy
reply, not a decision. Worker destination only; OFF unless the
`ANTHROPIC_API_KEY` secret is set (an optional binding exactly like
`DISCORD_WEBHOOK` and `TYREKICK_REVIEW_KEY`).

- **Field**: the stored record gains `ai_reply: string | null` (written once,
  then immutable). The `/receipts` projection returns it alongside `status`,
  `resolved_at`, and `resolution_note` so the widget can render it in the
  comment's own thread, labelled 🤖.
- **Model & cost guardrails (all four load-bearing)**: `claude-haiku-4-5`,
  `max_tokens: 120` (~0.15¢/call); a global daily cap enforced via KV key
  `ai:<YYYY-MM-DD>` incrementing against `AI_DAILY_CAP = 500` — once hit,
  generation is silently skipped for the rest of the day. Operators should
  also set an Anthropic workspace spend limit as the hard backstop; the daily
  cap is app-level and is not itself a substitute for the account-level ceiling.
- **No tools**: the model call carries no tool definitions. It can only emit
  text — a comment engineered to read as an instruction has nothing to invoke.
- **Untrusted-comment framing**: the comment body is wrapped in
  `<comment>...</comment>` delimiters inside the prompt, with an explicit
  instruction to ignore anything inside them that reads as a command to the
  model — the same untrusted-input posture AGENTS.md applies to agents,
  applied here to the model instead.
- **Generation is idempotent, async, and fail-silent**: triggered once per
  record via `ctx.waitUntil` so ingest latency is unaffected; a second attempt
  on an already-replied record is a no-op; any failure (rate limit, timeout,
  missing key, cap hit) leaves `ai_reply: null` and never surfaces to the
  reviewer or blocks ingest.
- **Visibility is author-only**: the reply rides the same per-author
  capability as `/receipts` (unguessable UUID lookups) — only the browser
  that submitted the comment ever fetches it. This is why shared review
  (`TYREKICK_REVIEW_KEY`) must stay OFF on a public page: the safety property
  this feature leans on is "nobody but the author asks," and shared review is
  precisely the mode that lets someone else read the thread.
- **The pin never changes status.** `ai_reply` is a thread message, not a
  triage transition — it does not set `approved`/`resolved`, does not touch
  `resolved_at`/`resolution_note`, and the model is never told it can close
  anything. A reviewer who gets an AI acknowledgement still has an `open` pin.

**Deliberately not built**: no tools, no multi-turn conversation, no
autonomous action of any kind. It is a mouth, not hands — it can say
something back; it cannot do anything.

## Retrospective — the AI feedback loop (addendum, 2026-07-23)

A fourth operating pattern, alongside passive monitor / active steward /
speculative steward (see "Operating patterns" above): the agent stops acting
on individual items and reads its own history back instead.

### MCP tool
`retrospective { project?, since?, limit? }` → `RetroReport` (`mcp/src/retrospective.ts`):
- `intents`: counts per intent — bug / copy / a11y / layout / data / request /
  question / praise / other — classified by deterministic keyword match on
  `body` (a record with `page_errors` is always `bug`). No LLM.
- `outcomes` (total + per-intent): resolved / declined / open. This split IS
  the hit/miss axis — resolved = reviewer and agent agreed it was a real miss
  and it got fixed; declined = the agent defended its output; open =
  neglected.
- `blindSpots`: `anchor.element` / `anchor.context.heading` / `anchor.selector`
  labels flagged 2+ times — a systematic miss, not a one-off.
- `byVersion`: counts grouped by `app_version` — regression watch.
- `aggregate`: counts + intent/version labels only. No `body`, no
  `reviewer_name`, no free text.

This is a READ-ONLY pattern: `retrospective` never calls `resolve_feedback`
or `triage_feedback`, and never touches source.

### Edge-run, normative
`retrospective` runs entirely inside the calling agent's own MCP session,
against the caller's own worker (`client.listFeedback`, same REST surface as
every other tool). No feedback content — not `body`, not anchor text, not
reviewer identity — is ever sent to any Tyrekick-operated service; there
isn't one to send it to. This is true of every tool in this package;
`retrospective` does not change it.

### The moat boundary
`aggregate` is the ONLY sub-report that is content-free by construction
(numbers + intent/version label strings, nothing else) and therefore the only
one that could ever be rolled up to a future central/fleet view without
Tyrekick becoming the thing every incumbent (Userback, Marker.io, BugHerd)
already is — a data-plane SaaS holding your reviewers' comments on their
servers. `intents`, `outcomes`, `blindSpots`, and `byVersion` (with their
example text and where-labels) stay local. If a fleet tier is ever built, it
is built on `aggregate` or it is not built.

### Honest limits
- **Miss-detector, not a looks-good signal.** Reviewers only ever pin
  problems; there is no positive/approval pin. The hit/miss axis above is
  reconstructed from resolve-vs-decline, not measured directly.
- **A positive pin is the natural next feature** — deliberately not built
  here. It is a new pin type and a payload schema bump, not a filter on
  existing data, so it waits for its own addendum.
- **"What was served" is seen through pin anchors** (the flagged element or
  section), not the agent's build or diffs — `retrospective` reasons over
  what reviewers pointed at, never over source.

## Verification comments are not feedback (addendum, 2026-09-01)

`tyrekick init` and the `make-reviewable` skill each POST one comment to prove the
destination works. Both now set `kind: "verification"` on the payload.

- The worker stores such a record with `status: "resolved"`, `resolved_at` equal to
  `received_at`, and a `resolution_note` saying it was a connectivity check. It is
  stored, not discarded: the proof that the pipe works is the point.
- It still tees to Discord, because mirroring is one of the things the check proves.
- It does NOT trigger an AI reply. Budget is for people.
- `kind` is optional. Absent, or any other value, stores `status: "open"` exactly as
  before, so every browser payload and every older client is unaffected.

Rationale: stored as "open", these accumulated. Across 17 live workers, 16 of 31 open
comments were the tooling talking about itself, and seven projects reported a backlog
no human had written. A queue that counts its own setup handshake cannot be trusted,
and an untrusted queue gets ignored.

## Review window: a review stands down (addendum, 2026-09-01)

A review link is not one-shot. Feedback arrives in waves: ship, gather, fix,
ship again. Until now every deployment was permanent and every ingest endpoint
stayed open forever, so a worker deployed for one afternoon in July still
accepts anonymous writes from anyone holding the URL. A deployment now has three
states:

- **open**: solicits and stores. Today's behaviour, and what every deployment
  that predates this addendum keeps doing.
- **closed**: ingest refuses. The page, the stored data, read-back, receipts
  and shared review all keep working. **The URL never changes.**
- **retired**: explicit teardown (`tyrekick remove --teardown`), which deletes
  the worker, the KV namespace and every comment in it. Never automatic.

### The var
`TYREKICK_OPEN_UNTIL`: a single ISO-8601 instant, a wrangler `[vars]` entry and
deliberately **NOT a secret**. It is readable on purpose. The widget is told the
review is closed and when, so there is nothing left to hide, and a plain var is
what lets `close` / `reopen` be one edited line plus a deploy.

**Fail open, in every unclear case.** Absent, empty, whitespace-only and
unparseable all mean the review NEVER closes. An operator typo (`"next friday"`)
can therefore fail to close a review; it can never silently shut a live one.
This is the single point of failure for back-compat and the one function that
carries an exhaustive unit test.

### What closing does and does not do
Closing gates **INGEST ONLY**, and the gate lives in `handleIngest` rather than
the router so both ingest routes and any future third are covered by one check.
`GET /feedback`, `GET /feedback/:id`, `PATCH /feedback/:id`, `GET /receipts` and
`GET /shared` never consult it. An agent pulls the full history out of a closed
project over MCP exactly as before, and a reviewer on a closed page still sees
their pins turn green when the builder resolves them.

Reopening bumps the instant and redeploys. Worker name, KV namespace id, routes
and the reviewed page's URL are untouched, by construction: the link already
shared keeps working across close and reopen, forever.

### Discovery
`GET /receipts` carries `review: {state, open_until}` in its envelope (see the
receipts addendum). `open_until` is echoed while the instant is still in the
FUTURE too, which is what lets a client say "open, closes 15 Sep" rather than
only open or closed. `GET /` is unchanged and gains no `review` key: it
advertises route names only and is not a configuration oracle.

The widget does **no pre-flight probe**. It learns a review is closed from the
403 when someone submits. Probing on load would tax every load of every open
review, which is the overwhelmingly common case, to improve the rare one, and
the reject-on-submit path has to exist regardless because a window can lapse
mid-sentence. If reviewers do complain about typing into a void, the upgrade is
a few lines on the `/receipts` call the widget already makes, which is exactly
why the window rides that response.

### CLI and registry
- `tyrekick close` (now), `tyrekick reopen --days N` (default 14) and
  `tyrekick reopen --never` (removes the window) edit the one `[vars]` line and
  run `wrangler deploy`. No confirmation prompt: closing destroys nothing and is
  one command to undo.
- `tyrekick status` gains a Review row; `tyrekick status --all` lists every
  deployment this machine has wired, probing each live under one `Promise.all`.
- The registry is `~/.tyrekick/deployments.json` (dir `0700`, file `0600`),
  OUTSIDE any repo: `{version:1, deployments:[{url, project, added_at}]}`.
  Three fields, and it **holds no secrets by construction**. There is no field
  a credential could land in. It caches no window state either: everything
  printed comes from a live probe at display time, so staleness is a non-event
  rather than a sync problem. It never auto-prunes on a failed probe (a deleted
  worker, a laptop on a plane and a DNS blip are one failed request either way);
  the only automatic deletion is a successful `remove --teardown`.

### Back-compat, which is the point
Every worker deployed before this var existed keeps behaving identically, even
after its code is redeployed: with no `TYREKICK_OPEN_UNTIL` set, the check
returns null and ingest runs byte-identically. A new widget against an old
worker sees no `review` key and does not read one. An old widget (pinned CDN,
already on someone's page) against a newly closed worker sees a non-2xx and
renders today's "Couldn't send. Copy your comment?". Degraded, not broken, and
the text is still recoverable via Copy and the saved draft.

**The honest limit.** The var lives in `[vars]`, so changing it needs
`wrangler deploy`, which needs a local wrangler config. A worker deployed from a
throwaway directory cannot be closed until its config is recreated. This feature
gives every new deployment a default stand-down and can list the old ones; it
cannot retroactively close them. If closing those matters more than the var
being readable, the thing to revisit is the var-not-secret decision, not this
design.

## File ownership (updated 2026-07-05)
The original multi-agent lanes (core / destinations / demo / tests as separate
agents) are retired — the project is maintained by one human + one agent and
the lanes were being waived case-by-case anyway. What REMAINS binding:

- `src/types.ts` is the canonical contract: never rename payload or config
  fields without a schema bump, and never extend the payload without bumping
  `schema`.
- `LICENSE` is untouchable.
- Changes to `package.json`, `build.mjs`, or `tsconfig.json` need the owner's
  explicit sign-off in the conversation where they happen.
