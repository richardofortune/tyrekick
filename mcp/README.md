# tyrekick-mcp

MCP server for [Tyrekick](../README.md) — the feedback overlay for AI-built
prototypes. Reviewers pin comments directly on your prototype; the comments land
in a Cloudflare Worker **you** own. This package closes the loop: it exposes
that feedback to Claude Code (or any MCP client) as tools, so your agent can
*pull* the feedback, fix what people flagged, and mark items resolved.

**Tools**

| Tool | What it does |
| --- | --- |
| `list_feedback` | List feedback (filter by `status`, `route`, `since`, `limit`), newest first, one readable summary per item |
| `get_feedback` | Full record for one item — body, route, anchor (x/y %, CSS selector, viewport), reviewer, environment |
| `resolve_feedback` | Mark an item resolved, optionally with a note about the fix |
| `feedback_stats` | Counts by status, route, and app_version |

## Setup

You need two values from the Cloudflare Worker destination
(`destinations/cloudflare/`):

1. **Worker URL** — the base URL printed by `wrangler deploy`, e.g.
   `https://tyrekick-feedback.<your-subdomain>.workers.dev`.
2. **Management token** — the secret the worker checks on `GET`/`PATCH`:

   ```sh
   wrangler secret put TYREKICK_TOKEN
   ```

   (Ingest — reviewers POSTing feedback — stays unauthenticated; the token only
   gates reading and resolving.)

### Add to Claude Code

```sh
claude mcp add tyrekick --env TYREKICK_URL=https://... --env TYREKICK_TOKEN=... -- npx tyrekick-mcp
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "tyrekick": {
      "command": "npx",
      "args": ["tyrekick-mcp"],
      "env": {
        "TYREKICK_URL": "https://tyrekick-feedback.your-subdomain.workers.dev",
        "TYREKICK_TOKEN": "your-management-token"
      }
    }
  }
}
```

Both environment variables are required — the server exits immediately with a
clear error if either is missing. A `401` from the worker means the token is
wrong or was never set: check `TYREKICK_TOKEN` and that
`wrangler secret put TYREKICK_TOKEN` was run.

## Workflow: the feedback loop

1. **Reviewers pin feedback.** You share the prototype (with the Tyrekick
   overlay embedded). Reviewers click "Give feedback", click a spot on the
   page, and type a comment. Each comment lands in your worker with the route,
   the click position, a CSS selector for the element under the pin, the
   viewport size, and the app version.

2. **You ask your agent to fix it.** In Claude Code, in the prototype's repo:

   > list the open feedback and fix what people flagged

3. **The agent works the list.** It calls `list_feedback { status: "open" }`
   to see what's outstanding, then `get_feedback { id }` for anything it needs
   in full. The record tells it *what* and *where*:

   - `route` — which page the comment is about
   - `anchor.selector` — the element the reviewer pinned
   - `anchor.x_pct` / `y_pct` + `anchor.viewport` — where on the page, and at
     what screen size (great for "broken on mobile" reports)
   - `app_version` — which build the reviewer was looking at

   Schema v2 payloads go further: `anchor.element` carries the clicked
   element's tag and visible text (or its label), and `anchor.context` the
   nearest heading and landmark — so the agent can grep the codebase for the
   exact string the reviewer saw (e.g. search for `"Find trips"` to land on
   the right component). `page_errors` lists the last uncaught page errors at
   submit time, which is often the actual bug. `list_feedback` surfaces all of
   this in each summary; v1 records simply omit the lines.

4. **The agent closes items out.** After fixing each one:

   `resolve_feedback { id, note: "moved the CTA above the footer" }`

   Next time reviewers (or you) check, `feedback_stats` shows what's open vs.
   resolved per route and version.

## Development

```sh
npm install
npm run build   # tsc → dist/, bin: dist/server.js
npm test        # vitest unit tests (fetch is mocked; no worker needed)
```

Node ≥ 18. Runtime deps are only `@modelcontextprotocol/sdk` and `zod`.

MIT © Frontier Operations
