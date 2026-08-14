# Tyrekick — Adversarial Security Review

> **Method.** Seven attack-lens agents probed the real source (worker, widget,
> MCP) across the system's trust boundaries; every candidate finding was then
> handed to an independent skeptic instructed to *refute* it against Tyrekick's
> actual threat model. 33 candidates → **21 survived refutation → 17
> actionable**. 12 were refuted or downgraded (listed in §7 so you can see they
> were considered). Findings are grouped by root cause and ranked by verified
> severity. Line references are to the code as reviewed.
>
> **Threat model.** Zero-backend: the builder owns the Worker + KV + webhook.
> Reviewers hold the prototype link and may be malicious. A "public attacker"
> exists only if the prototype URL is public. The coding agent acts on feedback.
> Deploy tiers: localhost/tunnel (low risk) vs public preview/own-domain (the
> worker template is the shield). See [`ARCHITECTURE.md`](ARCHITECTURE.md) §8.

## Executive summary

The system is sound in the ways that matter most for its niche: **comment
bodies, resolution notes, and AI replies render via `textContent` — there is no
HTML/script XSS in the render path** (confirmed, §6). Auth *fails closed*,
secrets never leak into logs/URLs, and the content-free aggregate holds.

The real exposure is concentrated at **one boundary — unauthenticated ingest —
which trusts the entire client payload.** Two HIGH issues and several supporting
ones all trace back to it, and both HIGH fixes are small and local. **Before any
public deploy, do the ingest hardening in §1.** The second theme worth acting on
is that **reviewer text reaches the coding agent with no "untrusted data"
framing** (§2) — a prompt-injection surface intrinsic to the loop.

| # | Severity | Boundary | Issue |
|---|---|---|---|
| 1 | **HIGH** | ingest | No body-size cap → KV storage amplification + read-path OOM DoS |
| 2 | **HIGH** | ingest | Attacker-controlled `id` → unauthenticated record **overwrite / un-resolve** |
| 3 | MEDIUM | MCP→agent | Reviewer text enters agent context with no untrusted-data framing |
| 4 | LOW–MED | shared review | Review key is a single global secret, not project-scoped |
| 5 | LOW | widget | `contentEditable` text + full URL captured into payload |
| 6 | LOW | MCP client | No timeout/retry; silent parse masks worker faults |
| 7 | INFO | auth | Write token uses non-constant-time compare (protection inverted) |
| 8 | INFO | widget | `accent` config interpolated raw into `<style>` (CSS injection) |

---

## 1. Unauthenticated ingest trusts the whole payload (root cause of the two HIGH findings)

`POST /feedback` is intentionally unauthenticated (reviewers stay frictionless).
But `handleIngest` stores the client payload with **near-zero validation** —
only `schema ∈ {1,2}`, non-empty `body`, and `MAX_BODY=2000` truncation
(`worker.ts:723-732`). Everything else is written to KV verbatim via
`{...payload}` (`worker.ts:741`). Three consequences:

### 1a. HIGH — No request-body-size limit → storage amplification + read-path OOM
`await request.json()` (`worker.ts:716`) parses the whole body before any size
check, and **only `body` is capped.** `page_errors`, the open-map `env`, and
`anchor.element/context` (typed `unknown`) pass straight through. An attacker
POSTs `body:"x"` plus a multi-MB `page_errors`/`env` blob, up to KV's ~25 MB
value ceiling — so the documented "one giant comment can't bloat a KV value"
guard is false (it bounds only the comment text). Worse, `handleList`
(`:838`, ≤200 bodies) and `handleShared` (`:693`, ≤100 bodies) fetch record
bodies **in parallel into one 128 MB isolate** — a page of fat records OOMs the
read path the builder and MCP agent depend on. `INGEST_LIMITER` caps request
*count*, not *size*, so it doesn't bound per-record cost.
*Attacker:* public. *Precondition:* public deploy. *Verdict:* CONFIRMED.
**Fix:** reject oversized ingest before parsing (byte-capped read, ~16 KB) and
cap total serialized record size in `saveRecord`, trimming/rejecting oversized
`page_errors`/`env`/`anchor`.

### 1b. HIGH — Attacker-controlled `id` → unauthenticated overwrite & un-resolve
`payload.id = payload.id || crypto.randomUUID()` (`worker.ts:737`) trusts a
client-supplied id, and `saveRecord` does a blind `KV.put("fb:"+id,…)`
(`:336`) — **no read-before-write, no existence check, no owner binding.**
`sharedView` returns every pin's `id` (`:621`), so a reviewer with the review
link enumerates other reviewers' ids, then re-POSTs a payload carrying a
victim's id. Because ingest always rebuilds the record as
`status:"open", resolved_at:null, resolution_note:null, ai_reply:null`
(`:742-746`), the overwrite both **replaces another reviewer's comment with
attacker content (impersonation via `reviewer_name`)** and **silently resets a
resolved item back to open**, wiping the note — the original author's
`/receipts` poll flips from "resolved + note" back to "open". No token needed.
*Attacker:* malicious reviewer (or public, for any id they learn).
*Verdict:* CONFIRMED. This breaks the "reviewers only ever pin problems"
invariant and is **not** an accepted tradeoff.
**Fix:** server-assign the id (ignore `payload.id`); or if an id is supplied,
`loadRecord` first and 409 when it already exists — ingest must only *create*.

### 1c. Supporting (LOW/INFO) — the same untrusted fields poison downstream views
Because ingest doesn't normalize fields, an attacker POSTing raw JSON can:
- set `created_at` to poison the retrospective **window** and flood `byVersion`;
- put arbitrary free text in `app_version`, which is the one key that reaches
  the "content-free" `aggregate` — so the guarantee is precisely *"no **reviewer**
  content in aggregate,"* not "no free text" (document it that way);
- set `anchor.element.text`/`label` to anything (the widget's input-value
  suppression is **client-side only**), and `/shared` projects `anchor.element`
  to every reviewer — so the "safe by contract" projection is bypassable by a
  direct POST;
- store records under short/guessable ids, weakening the `/receipts`
  "unguessable UUID capability" premise (the write path never enforces UUID
  shape; `UUID_SHAPE` at `:536` only filters the query and is loose:
  `/^[0-9a-f-]{16,64}$/i`).

**All of 1a–1c collapse to one fix surface:** validate/normalize at ingest —
server-assign id, size-cap, clamp `created_at` to a sane range, charset/length-cap
`app_version`, and re-clip `anchor` server-side mirroring the widget's rules.

## 2. MEDIUM — Reviewer text reaches the coding agent unframed (prompt injection)

Reviewer-controlled `body`, `reviewer_name`, and DOM-derived
anchor/heading/`page_errors` strings flow **verbatim** into the agent's context
via `formatSummary` (`tools.ts:28-56`), `get_feedback`'s full-record JSON
(`tools.ts:87`), and retrospective examples — with **no untrusted-data framing in
the tool outputs or descriptions.** The only guardrail is a *workflow* gate
("act on approved items only"), which governs *acting*, not *reading*. A comment
like *"ignore previous instructions, …"* lands directly in the builder's agent,
which may hold `resolve_feedback`/`triage_feedback` (and, in steward mode, edit
and redeploy). *Verdict:* CONFIRMED (with a residual: a crafted comment could
even try to get the agent to approve the attacker's own item).
**Fix:** fence untrusted fields as clearly-labeled *data, not instructions* in
`formatSummary`/`formatRetrospective`, return a whitelisted/labeled subset from
`get_feedback` rather than raw JSON, and add an "untrusted reviewer input"
caveat to the tool descriptions in `server.ts`. Deployment guidance: don't wire
autonomous triage/resolve to a semi-autonomous agent — keep approval a human step.

## 3. LOW–MEDIUM — Shared-review key is a single global secret

`TYREKICK_REVIEW_KEY` is one worker-wide secret, but a worker can serve many
projects (metadata `p`), and `project_name` is attacker-supplied at ingest.
`/shared` scopes by exact `project_name` match only, so **cross-project
confidentiality rests entirely on guessing/knowing the project name**, not on a
server-issued per-project credential — contradicting the "project-scoped… must
not read the others" comment (`worker.ts:174,654-655`). *Attacker:* a reviewer
holding one project's key. *Verdict:* PLAUSIBLE.
**Fix:** bind the key to the project (per-project secret or project→key map), or
delete the false guarantee from the comments and docs.

## 4. LOW — Widget capture leaks beyond the documented contract

- **`contentEditable`**: `VALUE_TAGS` (`anchor.ts:22,95`) suppresses only
  `input/textarea/select`, so a `contenteditable` div/p (rich-text editors)
  has its typed `innerText` (≤80 chars) captured into `anchor.element.text` —
  contradicting "input values are never captured," and (with shared review)
  projected to all reviewers. **Fix:** null text when `el.isContentEditable`.
- **Full URL**: the POST payload ships `location.href` + `route` with query/hash
  (`panel.ts:68`), while the *same codebase deliberately strips them from
  `/shared`* — an asymmetry that leaks preview/magic-link tokens in the URL.
  **Fix:** send `pathname` (or redact known token params) for the payload too.

## 5. LOW — MCP client robustness

The MCP REST client has **no `AbortController`/timeout/retry** (unlike the
widget's 8 s + 1 retry), so a slow/hung worker blocks the tool call — and the
agent — indefinitely (`client.ts:126-187`). Separately, a 2xx body that fails
`JSON.parse` silently becomes `json=null` → `extractList` returns `[]`
(`client.ts:161-168,93-102`), so a worker fault masquerades as "No feedback
found," quietly degrading retrospective/stats integrity.
**Fix:** add an 8 s timeout + one retry; on a non-empty 2xx body that fails to
parse, throw rather than return null.

## 6. INFO — Auth hardening & a confirmed-safe result

- **Inverted protection (INFO):** the high-value write token uses a
  non-constant-time `token !== env.TYREKICK_TOKEN` (`worker.ts:311`), while the
  *lower*-value review key gets a constant-time compare. Token routes are also
  un-rate-limited by design. Low practical risk over the network, but the
  hardening is backwards. **Fix:** compare the token with the existing
  `keyMatches`/`timingSafeEqual`.
- **`accent` CSS injection (INFO):** `accent` is interpolated raw into a
  shadow-root `<style>` (`styles.ts:31`); a crafted value (`;}…`) injects CSS
  (not JS). Builder-controlled, so low severity. **Fix:** validate against a
  hex/rgb pattern, fall back to default.
- **✅ Confirmed safe:** feedback bodies, resolution notes, and `ai_reply` all
  render via `textContent` (`drawer.ts:210,224,229,237`; `overlay.ts:66,138`)
  with `white-space:pre-wrap` — **no HTML/script XSS in the render path.**

## 7. Considered and refuted / downgraded (so you know they were checked)

The skeptic pass killed or downgraded these — mostly documented tradeoffs,
bounded effects, or duplicates of the above:

- **Rate limiters optional & fail-open** — deliberate availability choice; public
  deploys are instructed to configure them (documented tier behavior).
- **`AI_DAILY_CAP` bypass under concurrency** — the non-atomic counter only ever
  *undercounts* ("a few extra," never fewer); spend stays bounded by the cap +
  the account-level ceiling operators are told to set.
- **Global AI counter starves other projects** — same bounded surface; refuted.
- **localStorage stores sent bodies at rest** — any same-origin script can
  already read page state; not a new break (accepted, `persist`-gated).
- **`reviewer_name` impersonation / `project_name` forgeable / receipts loose
  UUID** — folded into §1b/§1c/§3 rather than counted separately.
- **`page_errors` exfiltrates to Discord** — same channel the builder already
  owns; `captureErrors` is documented and gated.
- **Non-2xx forwards 300 chars of worker body to the agent** — the worker is the
  builder's own; low signal.

---

*This review covers the code as mapped. It is a point-in-time assessment of the
prototype-tier system; the ingest hardening in §1 is the prerequisite for
treating a public deploy as anything more than "trusted link" scope.*
