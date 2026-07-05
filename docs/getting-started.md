# Getting started

Tyrekick has two install paths and two destination choices. This page gets you
from nothing to a working feedback loop, and helps you pick the right
destination for where your prototype lives.

## The one-command install

From your project folder:

```bash
npx tyrekick init
```

The installer asks for your webhook URL (or takes `--webhook <url> --yes` for a
non-interactive run), finds your HTML entry file, injects the script tag —
auto-detecting the transport from the URL and using the git short SHA as the
app version — sends a test comment, and prints the MCP setup command. It's
idempotent; run it again safely. Use `--file <path>` if your HTML entry is
unusual, `--no-test` to skip the test comment.

## The manual install

Add one script tag before `</body>` (for SPAs: the root HTML file; for
frameworks: the document/layout template):

```html
<script
  src="https://cdn.jsdelivr.net/npm/tyrekick@latest/dist/tyrekick.js"
  data-webhook="YOUR_DESTINATION_URL"
  data-transport="discord"
  data-app-version="v0.1"
  data-project-name="my-prototype"
></script>
```

Only `data-webhook` and `data-app-version` are required. Set
`data-transport="discord"` when the URL is a Discord webhook; leave it off (or
`"json"`) for a worker or any JSON endpoint. See
[Configuration](configuration.md) for every attribute.

Two conventions worth adopting on day one:

- **`data-app-version`: use the git short SHA** (`git rev-parse --short HEAD`).
  Every comment is stamped with it, so feedback maps to the exact build.
- **`data-project-name`: pick a stable kebab-case slug once** (e.g.
  `my-prototype`) and never change it. It's the project's identity across
  redeploys — preview hosts mint a new URL per deploy, so the URL can't be the
  identity, and the fallback (`document.title`) forks your feedback stream the
  first time the title changes.

For programmatic use (`npm install tyrekick`, ESM, no auto-init):

```ts
import { init, destroy } from "tyrekick";
init({ webhook: "…", appVersion: "v0.1", projectName: "my-prototype" });
```

## Verify it works

Load the page. A circular speech-bubble button appears in the corner. Click
it, click anywhere on the page, type a comment, hit **Send** (or
**Cmd/Ctrl+Enter**). Within a few seconds the comment should appear at your
destination. If it doesn't, see [Troubleshooting](troubleshooting.md).

## Choosing a destination

Two things decide this. First, the role: **Discord shows you it works in 60
seconds; the [Cloudflare Worker](destinations.md) is the actual loop** —
persistence, statuses, and your agent reading feedback over MCP all live
there. Discord is the taster, not the meal.

Second, where your prototype is **hosted** determines how much protection the
destination needs, because the webhook URL is visible in the page source by
design:

| Where the prototype lives | Who can reach it | Recommended destination |
| --- | --- | --- |
| `localhost` / LAN / screen-share | you | Discord webhook — zero setup |
| Tunnel (ngrok, cloudflared) | anyone with the ephemeral link | Discord is fine; worker if the link circulates |
| Preview/static host (Netlify, Cloudflare Pages, GitHub Pages…) | anyone with the URL | [Cloudflare Worker](destinations.md) — never a raw Discord webhook |
| Your own public domain | public, indexed | Worker, with rate limiting and validation enabled |

The reasoning: a raw Discord webhook URL in the source of a *public* page is a
spam cannon anyone can aim at your channel. The worker keeps the real secret
server-side and gives you a place to add validation. Full details, including
the worker's REST API, in [Destinations](destinations.md).

## Next steps

- Want your coding agent to read and fix the feedback? → [The agent loop](agent-loop.md)
- Want to know what reviewers can actually do? → [The reviewer experience](reviewing.md)
- Deploying somewhere public? → [Destinations](destinations.md)
