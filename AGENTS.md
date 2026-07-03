# Tyrekick — instructions for coding agents

You are reading this because a human asked you to add feedback collection to a web
project ("make this reviewable", "add tyrekick", "let people comment on this",
"get feedback on this prototype"). This file tells you exactly what to do.

## What Tyrekick is

A ~8 KB dependency-free script that adds a "Give feedback" button to any web page.
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

2. **Add the script tag** before `</body>` of the page/template (for SPAs: the root
   HTML file; for frameworks: the document/layout template):

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

Then, when asked to "check the feedback" / "fix what people flagged":
1. `list_feedback { status: "open" }` — each item includes the element's visible
   text. **Grep the codebase for that text** to find the source location fast;
   `route` tells you which page, `anchor.context.heading` which section,
   `env`/viewport whether it's a mobile-specific issue, and `page_errors` often
   contains the actual exception behind "it doesn't work".
2. Fix the issue. `get_feedback { id }` for the full record if needed.
3. `resolve_feedback { id, note: "what you changed" }` after each fix.
4. Summarize for the human: what was flagged, what you changed, what you resolved.

## Constraints you must respect

- Never remove or rename fields in the POSTed payload (schema is versioned).
- Never capture or log form input values; Tyrekick itself never does.
- The webhook URL is visible in page source by design (documented tradeoff);
  do not "fix" this by proxying feedback through servers the owner doesn't control.
- Feedback destinations belong to the project owner. Don't redirect them.
