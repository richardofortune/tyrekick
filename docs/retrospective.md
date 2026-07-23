# Guide: retrospective

**What it does:** reads back your own feedback-and-resolution history and
reports what reviewers keep flagging, what your agent did about it, and where
the same problem keeps recurring — a coaching pass on your agent's own track
record, not a new way to act on feedback.

**When to use it:** periodically, or whenever you're about to write (or
rewrite) an agent brief for a project that has some history behind it — "what
should I tell it to stop doing."

**Cost/effort:** nothing to set up. It's another tool on the MCP server you
already have running for [the agent loop](agent-loop.md).

---

## Ask for it

In your agent, in the project:

> run the retrospective on my feedback

The agent calls the `retrospective` MCP tool (`{ project?, since?, limit? }`)
and narrates the result back to you as coaching, not a raw dump.

## What it tells you

- **What reviewers keep flagging** — feedback bucketed by intent (bug / copy
  / a11y / layout / data / request / question / praise), classified by
  keyword match on the comment text. No model call, no judgment — a bucket is
  a word match, not an opinion.
- **What the agent did about each** — resolved, declined, or still open. This
  is the closest thing to a hit/miss score: **resolved** means the reviewer
  and the agent agreed something was really wrong, and it got fixed — a
  genuine miss, caught and closed. **Declined** means the agent judged the
  comment out of scope or mistaken and said so. **Open** means it just sat
  there. A project with a lot of "open" isn't being reviewed by its agent;
  it's just being reviewed.
- **Recurring blind spots** — the same element or section flagged more than
  once is a systematic miss, not a fluke. This is usually the most useful
  line in the report: one date-picker complaint is a one-off; three are a
  brief you haven't written yet.
- **Regressions by version** — the same complaint reappearing after an
  `app_version` bump that should have fixed it.

Your agent turns this into something like: "reviewers have flagged your date
inputs four times across three versions, and two of those are still open —
worth adding 'make date fields obvious' to your brief."

## Why nothing leaves your machine

`retrospective` runs the same way every other Tyrekick MCP tool does: your
agent calls it, it reads your own worker over your own MCP connection, and
the answer comes back into your own context. There's no Tyrekick backend
anywhere in that path — no service to send your reviewers' comments to.

The one exception, and it's a narrow one: the report includes an `aggregate`
sub-report that is deliberately **content-free** — counts and intent/version
labels only, no comment text, no reviewer names. That's the only shape of
this data built to ever leave your machine, and it's what a future paid fleet
view (if one is ever built) would be built on — never the comments
themselves. Every other incumbent in this space (Userback, Marker.io,
BugHerd) is a data-plane SaaS: your reviewers' words live on their servers.
Tyrekick never sees a single one, on this feature or any other.

## Honest limits

- **It's a miss-detector, not an approval score.** Reviewers only ever pin
  problems — there's no "looks good" pin yet — so the hit/miss read above is
  reconstructed from resolve-vs-decline, not measured directly. A real
  positive-feedback pin is the natural next step here; it's deliberately not
  built, because it means a new pin type and a schema version, not a quick
  addition.
- **It sees what was flagged, not what was built.** The report reasons over
  pin anchors — the element or section a reviewer clicked — not your agent's
  diffs or build history. It tells you where reviewers kept pointing, not
  what your codebase actually looked like at the time.

## See also

- [The agent loop](agent-loop.md) — the tools that act on individual items;
  `retrospective` is the one that looks back across all of them instead
- [`mcp/README.md`](../mcp/README.md) — full tool reference
