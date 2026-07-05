# Tyrekick — instructions for coding agents

You are reading this because a human asked you to add feedback collection to a web
project ("make this reviewable", "add tyrekick", "let people comment on this",
"get feedback on this prototype"). This file tells you exactly what to do.

## What Tyrekick is

A ~12 KB (gzipped) dependency-free script that adds a "Give feedback" button to any web page.
Reviewers click a spot, type a comment, submit. The comment POSTs as structured JSON
(element, visible text, heading, route, viewport, page errors) to a webhook the
project owner controls. Later, you (or another agent) can pull the feedback back over
MCP and act on it. Reviewers never need accounts.

## Install (widget)

1. **Ask the human ONE question** (skip if already configured in this project):
   > "Where should feedback go — a Discord webhook URL (easiest: Server Settings →
   > Integrations → Webhooks → New Webhook → Copy URL), or a deployed Tyrekick
   > worker URL?"
   Remember the answer for this project (e.g. note it in the project's CLAUDE.md or
   equivalent).

2. **Run the installer** (preferred — does everything below in one command):

   ```bash
   npx tyrekick init --webhook THEIR_WEBHOOK_URL --yes
   ```

   It finds the HTML entry file, injects the script tag (transport auto-detected
   from the URL, app version from the git SHA), sends a test comment, and prints
   the MCP setup command. Idempotent. Use `--file <path>` if the HTML entry is
   unusual, `--no-test` to skip the test comment.

   **Manual alternative** — add the script tag before `</body>` of the
   page/template (for SPAs: the root HTML file; for frameworks: the
   document/layout template):

   ```html
   <!-- Discord destination -->
   <script src="https://cdn.jsdelivr.net/npm/tyrekick@latest/dist/tyrekick.js"
           data-webhook="THEIR_DISCORD_WEBHOOK_URL"
           data-transport="discord"
           data-app-version="APP_VERSION"
           data-project-name="PROJECT_NAME"></script>
   ```

   ```html
   <!-- Worker / any JSON endpoint destination -->
   <script src="https://cdn.jsdelivr.net/npm/tyrekick@latest/dist/tyrekick.js"
           data-webhook="https://their-worker.workers.dev/feedback"
           data-app-version="APP_VERSION"
           data-project-name="PROJECT_NAME"></script>
   ```

   - `data-app-version`: use the current git short SHA if the project is a repo
     (`git rev-parse --short HEAD`) — this lets future agents map feedback to the
     exact build. Otherwise any version string.
   - `data-project-name`: **choose a stable kebab-case slug ONCE at install**
     (e.g. `brew-buddy`) and record it in the project's CLAUDE.md. This is the
     project's identity across deploys — preview hosts mint a NEW URL per deploy,
     so the URL cannot be the identity, and if this attribute is omitted it
     defaults to `document.title`, which forks the feedback stream the first time
     anyone edits the title. Never derive it from the page title; never change it.
   - ESM alternative: `npm install tyrekick` then
     `import { init } from "tyrekick"; init({ webhook, appVersion, ... })`.
   - Optional attributes: `data-position="bottom-left"`, `data-accent="#hex"`,
     `data-branding="false"`, `data-capture-errors="false"`.

3. **Verify**: load the page; a circular speech-bubble button appears bottom-right.
   Do not submit test feedback to a real Discord channel without telling the human.

## Reading feedback back (MCP)

If the project uses the worker destination, register the MCP server once:

```bash
claude mcp add tyrekick \
  --env TYREKICK_URL=https://their-worker.workers.dev \
  --env TYREKICK_TOKEN=their-token \
  -- npx tyrekick-mcp
```

### Review modes — decide BEFORE actioning anything

Feedback has a triage ladder: `open` (untriaged) → `approved` / `declined` →
`resolved`. Which items you may action depends on WHO left the feedback:

- **Self-review** ("my punch list"): the human confirms the open feedback is
  their own pins on the build. Their pins ARE the approvals — you may action
  `open` items directly.
- **Shared review** ("suggestion box", the DEFAULT when unsure): reviewers other
  than the project owner left the feedback. Treat `open` items as untriaged
  opinions — they may conflict, be out of scope, or be wrong. **Only action
  items with status `approved`.** Offer to walk the human through triage first:
  list the open items, let them decide, record decisions with
  `triage_feedback { id, status: "approved"|"declined", note }`.

If the human hasn't said whose feedback it is, ask one question: "Is this your
own feedback, or from other reviewers?" Never silently reshape someone's
project around untriaged strangers' comments.

### Operating patterns — passive monitor vs active steward

Decide (with the human) which pattern you're running; they trade friction for
risk in opposite directions:

- **Passive monitor** — read-only. Poll `list_feedback` / `feedback_stats` on a
  cadence, digest what came in, optionally triage with `triage_feedback`, and
  report. Touch no source. This is deliberately a *lighter* thing than an issue
  tracker: when the work is ephemeral (prototypes iterated daily), tracking
  issues against builds that will be replaced tomorrow is ceremony — collect,
  summarize, let the human point. Do not add tracker weight (no sprints, no
  boards, no severity taxonomies).
- **Active steward** — lowest friction: treat every actionable comment as a work
  item, fix it, redeploy, resolve. This is RISKY by construction — reviewers may
  be wrong, conflicting, or out of scope — so the triage ladder is the brake:
  active stewardship over `open` items is permitted ONLY in self-review mode
  (the owner's own pins). In shared review, active mode operates on `approved`
  items only. When in doubt, run passive and propose.

**Closing the loop across redeploys:** acting usually means redeploying, and on
preview hosts the redeploy gets a NEW URL. The feedback you resolved points at
the old deploy. Therefore every `resolve_feedback` note after a redeploy MUST
include the new deploy URL and the new app version, e.g.
`note: "Moved CTA above the fold — see https://deploy-def456.example.app (v3a9c1f2)"`.
The stable `data-project-name` (see install) is what ties the before/after
streams together; the note is how the humans follow you across the URL change.

**Why the exchange is worth keeping even when the work is disposable:** the
feedback→fix→resolve record is a learning corpus. Patterns across a builder's
projects ("reviewers always flag contrast", "mobile layouts draw the most
pins") are informative even after every prototype involved is dead. Write
resolution notes as if someone will mine them later — because something will.

### The loop

Then, when asked to "check the feedback" / "fix what people flagged":
1. `list_feedback { status: "open" }` (or `status: "approved"` in shared
   review) — each item includes the element's visible text. **Grep the codebase
   for that text** to find the source location fast; `route` tells you which
   page, `anchor.context.heading` which section, `env`/viewport whether it's a
   mobile-specific issue, and `page_errors` often contains the actual exception
   behind "it doesn't work".
2. Fix the issue. `get_feedback { id }` for the full record if needed.
3. `resolve_feedback { id, note: "what you changed" }` after each fix. If a
   comment was too ambiguous to be sure, resolve with a note starting
   "INTERPRETED:" so the human knows to confirm.
4. Summarize for the human: what was flagged, what you changed, what you
   resolved, what you declined or left for them.

## Constraints you must respect

- Never remove or rename fields in the POSTed payload (schema is versioned).
- Never capture or log form input values; Tyrekick itself never does.
- The webhook URL is visible in page source by design (documented tradeoff);
  do not "fix" this by proxying feedback through servers the owner doesn't control.
- Feedback destinations belong to the project owner. Don't redirect them.
