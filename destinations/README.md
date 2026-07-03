# Destinations — pick where feedback goes

`Tyrekick` never runs a backend. When a reviewer submits a comment, the
widget POSTs a JSON [`FeedbackPayload`](../src/types.ts) to a URL **you** own.
You choose that URL. Two first-class options are documented here:

| | **Discord** (default, zero-code) | **Cloudflare** (owned storage) |
|---|---|---|
| Setup | Copy a webhook URL, paste it | Deploy a tiny TypeScript Worker |
| Where it lands | A chat channel, as a message | Workers KV, as structured JSON |
| Format | Human-readable chat message | Full payload record (queryable) |
| Cross-origin? | Yes — Discord webhooks are CORS-enabled, browser POSTs directly | Yes (permissive CORS) **or** same-origin (Pages Function, no CORS at all) |
| Transport | `transport: "discord"` | `transport: "json"` (default) |
| Best for | Fast prototypes, team chat, "just tell me" | Keeping/querying feedback, dashboards, exports |

## Which should I pick?

- **Just want to see comments roll in with no work?** → [Discord](./discord/README.md).
  Make a webhook, paste the URL, done. No server, no deploy, no build step.
- **Want to keep, sort, or export feedback as structured data?** →
  [Cloudflare](./cloudflare/README.md). A ~1-file TypeScript Worker stores each
  payload in Workers KV, and can be deployed same-origin so there's no CORS.

## Anything else?

The `"json"` transport POSTs the raw payload to any URL. So **any CORS-enabled
endpoint or form backend works too** — a Netlify/Vercel function, an AWS Lambda
URL, Formspree, a Google Form endpoint, your own API — as long as it accepts a
JSON `POST` and (for cross-origin prototypes) returns permissive CORS headers.
Success is HTTP 2xx and, if a body is returned, it is not `{"ok":false}`.
