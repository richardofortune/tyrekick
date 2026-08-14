# Tyrekick — System Architecture

> A consolidated, reviewer-facing map of how Tyrekick actually works, drawn from
> the source (not just the spec). For the running build spec see
> [`CONTRACT.md`](../CONTRACT.md); to *use* Tyrekick see [`README.md`](README.md)
> (humans) / [`AGENTS.md`](../AGENTS.md) (agents). Diagrams live in
> [`docs/diagrams/`](diagrams/) (`.excalidraw`, open at excalidraw.com).

## 1. What it is, in one paragraph

Tyrekick is a **zero-backend** comment-overlay for web prototypes. A reviewer
clicks a point on the page, types a comment, and the embedded **widget** POSTs a
JSON payload to a **Cloudflare Worker** the *builder* owns. The Worker stores
records in Workers **KV**. A coding **agent** (Claude Code) later pulls that
feedback through a stdio **MCP server**, fixes what was flagged, and resolves it
with a note — which flows back to the reviewer's browser as a **receipt** that
turns their pin green. There is no Tyrekick-operated backend anywhere in that
path; the builder owns every hop.

The three components total ~3,260 LOC: widget `src/` (~1,240), worker
`destinations/cloudflare/worker.ts` (1,041), MCP `mcp/src/` (~980).

See **[`01-system-overview`](diagrams/01-system-overview.excalidraw)**.

## 2. Components

### 2.1 Widget (`src/`) → `dist/tyrekick.js`
An embeddable overlay that renders **entirely inside one Shadow-DOM host**
(`<div data-tyrekick>`, `attachShadow({mode:"open"})`, `src/index.ts:368-371`)
so it never mutates host-page styles. Two builds: IIFE (`window.Tyrekick`,
auto-inits from its own `data-*` attributes) and ESM (`init`/`destroy`). Budget
≤30 KB gz.

- **Entry / lifecycle**: `init(config)` (`src/index.ts:341`), `destroy()` (`:429`),
  single instance per page (`rt` singleton `:164`).
- **Capture**: crosshair layer → click → compute anchor → composer. Selector
  computation excludes the widget itself by skipping `host.contains(cand)` in
  `elementsFromPoint` (`src/capture/anchor.ts:52-74`).
- **Payload (schema v2)** built in `src/ui/panel.ts:57-79` — see §4.
- **Transport** (`src/transport/webhook.ts`): POST, 8 s `AbortController`
  timeout, exactly one retry after 2 s; `json` or `discord`.
- **Persistence** (localStorage, `persist` default on): unsent drafts + failed
  comments for recovery, and — json transport only — delivered-comment
  **receipts** so closure can reach the reviewer (`src/index.ts:520-558`).
- **Receipts / shared polling**: throttled (≥60 s) GETs to `/receipts` and
  `/shared`, silent on every failure.

### 2.2 Worker (`destinations/cloudflare/worker.ts`)
The builder's owned edge. Open ingest + a token-gated management face + two
unauthenticated read routes with their own capability models. Single KV
namespace `FEEDBACK`. See §3 (routes) and §5 (storage).

### 2.3 MCP server (`mcp/src/`) → npm `tyrekick-mcp`
A stdio MCP server (`@modelcontextprotocol/sdk`) the agent connects to. It
translates six tool calls into REST calls against the Worker
(`TYREKICK_URL` + `Bearer TYREKICK_TOKEN`). Env is validated fail-fast at
startup (`mcp/src/env.ts`); every tool converts errors into MCP tool-errors
rather than crashing (`mcp/src/tools.ts:20-23`). See §6.

## 3. HTTP surface (Worker)

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/feedback`, `/` | POST | **none** (rate-limited) | Ingest a feedback payload |
| `/feedback` | GET | Bearer `TYREKICK_TOKEN` | List records (metadata-filtered) |
| `/feedback/:id` | GET | Bearer `TYREKICK_TOKEN` | Full single record |
| `/feedback/:id` | PATCH | Bearer `TYREKICK_TOKEN` | Triage / resolve / reopen |
| `/receipts?ids=` | GET | **none** (capability UUIDs) | Author-only status + `ai_reply` |
| `/shared?project=&route=` | GET | `X-Tyrekick-Review-Key` | Cross-reviewer projection |
| `/` | GET | none | Health / route discovery |

- **Ingest is deliberately unauthenticated** (reviewers stay frictionless);
  protection is rate limiting + body caps.
- **Management routes** (`GET`/`PATCH`) require the Bearer token and are *not*
  rate-limited (the token is the gate). Router at `worker.ts:942`.
- Errors are `{ok:false,error:"<code>"}`; success `{ok:true,...}`.

## 4. Payload (schema v2)

Constructed client-side (`src/ui/panel.ts:57-79`; canonical types in
`src/types.ts`). Key fields and their privacy properties:

- **Position**: `x_pct`/`y_pct` (document-relative, 1 dp), `anchor.selector`
  (≤5 segments, never the widget).
- **`anchor.element`**: `tag/id/testid/role/text/label/rect`. **Text is bounded
  to ≤80 chars** (`MAX_TEXT`, `anchor.ts:21`) and **`<input>/<textarea>/<select>`
  values are suppressed** (`VALUE_TAGS`, `anchor.ts:22,95`) — the greppable
  bridge from rendered DOM to source, without capturing typed secrets.
- **`anchor.context`**: nearest heading + landmark path (≤3 segments).
- **`env`**: screen/dpr/dark/touch/user-agent/language (fingerprint-ish; withheld
  from `/shared`).
- **`page_errors`**: last ≤5 uncaught errors/rejections, each ≤200 chars;
  console is never patched; gated by `captureErrors`.
- **`session_id`**: one UUID per page load. **`id`**: one UUID per send attempt.

## 5. Storage (KV)

- **Key** `fb:<id>`; **value** = the full payload + server fields
  `{status, received_at, resolved_at, resolution_note, ai_reply}`.
- **Metadata** `{t:created_at, s:status, r:route, p:project_name}` — compact so
  list/filter reads metadata only, fetching bodies just for the returned page.
- **AI budget counter** `ai:<YYYY-MM-DD>` in the same namespace.
- **Records are never deleted** (no `delete` in the KV surface). List/shared walk
  the `fb:` keyspace, filter on metadata, sort, and slice one page
  (`worker.ts:803-812`, `660-667`). KV list caps at 1000/call — prototype scale;
  D1 is the documented upgrade path.

## 6. MCP tool surface

| Tool | Params | REST call | Returns |
|---|---|---|---|
| `list_feedback` | `status?/route?/project?/since?/limit?` | `GET /feedback?…` | text summaries |
| `get_feedback` | `id` | `GET /feedback/:id` | full record JSON |
| `triage_feedback` | `id, status(approved\|declined), note?` | `PATCH` | confirm |
| `resolve_feedback` | `id, note?` | `PATCH status=resolved` | confirm |
| `feedback_stats` | `project?` | `GET …limit=200` | counts by status/route/version |
| `retrospective` | `project?/since?/limit?` | `GET …` | local coaching report |

`retrospective` (`mcp/src/retrospective.ts`) is **read-only** — it classifies
intents by deterministic keyword match, computes the resolved/declined/open
hit-miss axis, recurring blind spots, and volume by version. Its **`aggregate`
sub-report is content-free by construction** (integers + fixed intent-enum
labels + `app_version` strings only — no comment bodies, no reviewer names,
verified at `retrospective.ts:260-266`). Caveat: `app_version` keys are
*builder*-supplied, so the guarantee is precisely "no **reviewer** content."

## 7. The loop

**capture → deliver → (ack) → recall → steward → close**, with
**retrospective** reading back across all items. See
**[`02-feedback-loop`](diagrams/02-feedback-loop.excalidraw)**. Four documented
operating patterns govern how far the agent goes: *passive monitor*, *active
steward*, *speculative steward* (preview-deploy, keep-or-kill), and
*retrospective*. Project identity is carried by the stable `project_name`, not
the URL (preview hosts mint a new origin per deploy).

## 8. Trust boundaries & auth

See **[`03-trust-boundaries`](diagrams/03-trust-boundaries.excalidraw)**.

- **Untrusted client zone** — the reviewer + widget hold the link and may be
  malicious. Everything they send is attacker-controllable.
- **Builder-owned edge** — Worker + KV. Gates: Bearer `TYREKICK_TOKEN` (write),
  `X-Tyrekick-Review-Key` (`/shared`), capability UUID (`/receipts`, author-only),
  rate limiters (ingest 15/min, read 120/min, per `CF-Connecting-IP`).
- **Builder-owned agent host** — the coding agent + MCP server, holding the
  write token.

**Optional capabilities**, each off unless its secret is set:
`TYREKICK_REVIEW_KEY` (shared review — public-by-construction, private links
only), `DISCORD_WEBHOOK` (mirror), `ANTHROPIC_API_KEY` + `AI_DAILY_CAP` (Haiku
courtesy ack — no tools, `<comment>`-delimited untrusted framing, author-only via
`/receipts`). `tyrekick status` audits this posture, including the dangerous
**shared-review + AI-reply** combination.

> **Security posture is documented separately.** An adversarial end-to-end review
> lives in [`docs/security-review.md`](security-review.md) — read it before a
> public deploy. Highlights the review surfaces: unauthenticated ingest with an
> attacker-settable `id`, the review key's project-agnostic scope, rate-limiter
> fail-open, and — the highest-signal one — reviewer text reaching the coding
> agent's context without untrusted-input framing.

## 9. Build & deployment

See **[`04-deployment`](diagrams/04-deployment.excalidraw)**.

- **Widget**: `node build.mjs` → `dist/tyrekick.js` (IIFE) + `.esm.js`; embed via
  `<script>` on any origin (GitHub Pages, Cloudflare Pages, tunnel).
- **Worker**: `wrangler deploy` + a KV namespace; secrets via
  `wrangler secret put`.
- **MCP**: `npm publish` → `npx tyrekick-mcp`; register with
  `claude mcp add tyrekick --env TYREKICK_URL=… --env TYREKICK_TOKEN=… -- npx tyrekick-mcp`.

## 10. Deliberate non-goals

No reviewer accounts, no live presence/peer-to-peer threading, no tracker weight
(boards/sprints/severity), no screenshots/`html2canvas`. Comments meet at the
builder's destination, not on the page. The widget never grows accounts or
dashboards — configuration and posture-checking live in the local CLI
(`tyrekick status`).
