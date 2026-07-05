# The agent loop (MCP)

The reason Tyrekick exists: feedback isn't just collected — your coding agent
pulls it, acts on it, and resolves it. Requires the
[Cloudflare Worker destination](destinations.md) (Discord is write-only).

## Setup (once)

```bash
claude mcp add tyrekick \
  --env TYREKICK_URL=https://tyrekick-feedback.YOUR.workers.dev \
  --env TYREKICK_TOKEN=your-token \
  -- npx tyrekick-mcp
```

Works with any MCP client. Full server docs: [`mcp/README.md`](../mcp/README.md).

## The five tools

| Tool | Args | Does |
| --- | --- | --- |
| `list_feedback` | `{ status?, route?, since?, limit? }` | Summaries: id, created_at, status, route, body, reviewer, `anchor.selector`, app_version |
| `get_feedback` | `{ id }` | Full record incl. anchor + env + page_errors |
| `triage_feedback` | `{ id, status: "approved"\|"declined", note? }` | Record the owner's decision |
| `resolve_feedback` | `{ id, note? }` | Mark fixed, with a note explaining what changed |
| `feedback_stats` | `{}` | Counts by status, route, and app_version |

## Review modes — decide before acting

Whose feedback is it? That determines what an agent may touch:

- **Self-review** ("my punch list"): the open feedback is the owner's own
  pins. Their pins *are* the approvals — agents may action `open` directly.
- **Shared review** (the default when unsure): other people left the
  feedback. `open` items are untriaged opinions — possibly conflicting, out
  of scope, or wrong. Agents action **`approved` only**, and offer to walk
  the owner through triage first.

## Operating patterns

Two documented ways to run the consuming agent — they trade friction for risk
in opposite directions:

**Passive monitor** — read-only. Poll `list_feedback` / `feedback_stats` on a
cadence, digest, optionally triage, report. Deliberately *lighter* than an
issue tracker: for fast-moving prototypes, collecting and summarizing beats
tracking. No boards, no sprints, no severity taxonomies — ever.

**Active steward** — every actionable comment becomes a work item: fix,
redeploy, resolve. Lowest friction, risky by construction; the triage ladder
is the brake (active over `open` only in self-review). When in doubt, run
passive and propose.

## The working loop

When asked to "fix what people flagged":

1. `list_feedback { status: "open" }` (or `"approved"` in shared review).
   Each item carries the element's **visible text — grep your source for it**
   to find the location fast. `route` says which page,
   `anchor.context.heading` which section, `env` whether it's mobile-specific,
   and `page_errors` often contains the actual exception behind "it doesn't
   work".
2. Fix it. `get_feedback { id }` if you need the full record.
3. `resolve_feedback { id, note }` after each fix. Two note conventions:
   - If the comment was ambiguous, start the note with `INTERPRETED:` so the
     human knows to confirm.
   - **After a redeploy that changed the URL, the note must carry the new
     deploy URL and app version** — preview hosts mint a new URL per deploy,
     and the note is how humans follow the loop across the change.
4. Summarize for the human: flagged / changed / resolved / declined-with-why.

`declined` with a reason matters as much as `resolved` — reviewers who are
silently ignored stop reviewing.

## Why resolution notes are written carefully

The feedback → fix → resolve exchange is retained as a learning corpus. Even
when every prototype involved is disposable, patterns across a builder's
projects ("reviewers always flag contrast", "mobile draws the most pins")
stay informative. Write notes as if someone will mine them later.
