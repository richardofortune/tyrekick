# Destinations — pick where feedback goes

`Tyrekick` never runs a backend. When a reviewer submits a comment, the
widget POSTs a JSON [`FeedbackPayload`](../src/types.ts) to a URL **you** own.
You choose that URL. Three first-class options are documented here:

| | **Discord** (default, zero-code) | **Cloudflare** (owned storage) | **Self-hosted** (owned storage) |
|---|---|---|---|
| Setup | Copy a webhook URL, paste it | Deploy a tiny TypeScript Worker | Run a Docker container |
| Where it lands | A chat channel, as a message | Workers KV, as structured JSON | SQLite file, on a volume you mount |
| Format | Human-readable chat message | Full payload record (queryable) | Full payload record (queryable) |
| Cross-origin? | Yes — Discord webhooks are CORS-enabled, browser POSTs directly | Yes (permissive CORS) **or** same-origin (Pages Function, no CORS at all) | Yes (permissive CORS) |
| Transport | `transport: "discord"` | `transport: "json"` (default) | `transport: "json"` (default) |
| Best for | Fast prototypes, team chat, "just tell me" | Keeping/querying feedback, dashboards, exports, no infra to run | Same, but on infra you control (VPS, homelab, k8s) instead of Cloudflare |

## Which should I pick?

- **Just want to see comments roll in with no work?** → [Discord](./discord/README.md).
  Make a webhook, paste the URL, done. No server, no deploy, no build step.
- **Want to keep, sort, or export feedback as structured data, with nothing to run yourself?** →
  [Cloudflare](./cloudflare/README.md). A ~1-file TypeScript Worker stores each
  payload in Workers KV, and can be deployed same-origin so there's no CORS.
- **Want the same structured storage but running on your own infrastructure?** →
  [Self-hosted](./self-hosted/README.md). A single Go binary in a Docker
  container, storing feedback in SQLite on a mounted volume. Same REST API as
  the Cloudflare Worker, so `tyrekick-mcp` and everything else works
  unchanged — just point it at your container instead.

## Anything else?

The `"json"` transport POSTs the raw payload to any URL. So **any CORS-enabled
endpoint or form backend works too** — a Netlify/Vercel function, an AWS Lambda
URL, Formspree, a Google Form endpoint, your own API — as long as it accepts a
JSON `POST` and (for cross-origin prototypes) returns permissive CORS headers.
Success is HTTP 2xx and, if a body is returned, it is not `{"ok":false}`.
