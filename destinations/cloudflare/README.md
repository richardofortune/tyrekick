# Cloudflare destination (owned structured storage)

Deploy a tiny TypeScript Cloudflare Worker that receives each `FeedbackPayload`
and stores it in **Workers KV**. Unlike the Discord destination (chat messages),
this keeps every comment as structured JSON you can list, read back, and export.

This uses the widget's default `transport: "json"`, which POSTs the raw payload.

Files in this folder:

- **`worker.ts`** — the Worker (handles CORS, validates, stores in KV, and
  serves a token-gated REST API for reading feedback back).
- **`wrangler.toml`** — config with the KV binding placeholder.

## 1. Install Wrangler

Wrangler is Cloudflare's CLI. You need a (free) Cloudflare account.

```bash
npm install -g wrangler   # or: npm install -D wrangler
wrangler login            # opens a browser to authorize
```

## 2. Create the KV namespace

From inside this `destinations/cloudflare/` folder:

```bash
wrangler kv namespace create FEEDBACK
```

It prints a block containing an `id`. Copy that id.

## 3. Paste the id into wrangler.toml

Open `wrangler.toml` and replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with the id
from the previous step:

```toml
[[kv_namespaces]]
binding = "FEEDBACK"
id = "a1b2c3d4e5f6...."   # <- your real id
```

(You don't need to edit `worker.ts` at all.)

## 4. Deploy

```bash
wrangler deploy
```

Wrangler prints your deployed URL, e.g.:

```
https://tyrekick-feedback.<your-subdomain>.workers.dev
```

## 5. Point the widget at it

Copy that `workers.dev` URL and paste it as the widget's `webhook`. The `json`
transport is the default, so you don't have to set `transport` at all.

```js
Tyrekick.init({
  webhook: "https://tyrekick-feedback.your-subdomain.workers.dev",
  appVersion: "1.0.0",
  // transport: "json"  // default — no need to set it
});
```

Or the zero-JS `data-*` form (IIFE build):

```html
<script
  src="https://your-host/dist/tyrekick.js"
  data-webhook="https://tyrekick-feedback.your-subdomain.workers.dev"
  data-app-version="1.0.0"
></script>
```

Submit a comment. On success the Worker responds `{"ok":true}`; on a bad request
it responds `{"ok":false,"error":"..."}`, which the widget treats as a failure so
the reviewer can copy their text instead of losing it.

## Same-origin option (no CORS at all)

If your static prototype is itself hosted on **Cloudflare Pages**, you can run
this exact code as a **Pages Function** so the widget and the endpoint share an
origin — then there is no cross-origin request and CORS never comes into play.

1. In your Pages project, create a `functions/` directory next to your static
   files.
2. Copy `worker.ts` to `functions/api/feedback.ts`. The default export works
   unchanged as a Pages Function — the file's path becomes its route.
3. Add the KV binding to the Pages project (Dashboard → your Pages project →
   **Settings → Functions → KV namespace bindings**): variable name `FEEDBACK`,
   bound to the namespace you created in step 2. (Pages uses the dashboard
   binding rather than `wrangler.toml`.)
4. Point the widget at the same-origin path — no full URL needed:

   ```js
   Tyrekick.init({
     webhook: "/api/feedback",
     appVersion: "1.0.0",
   });
   ```

Because the request is same-origin, the browser never sends a CORS preflight.
(The CORS headers in `worker.ts` are simply ignored in this mode, so the one
file serves both deployments.)

> In Pages mode the routes below live under your function's path, e.g.
> `GET /api/feedback` instead of `GET /feedback`.

## Reading feedback back (REST API)

Ingest is open (reviewers stay frictionless), but the Worker also serves a
**token-gated management API** so you — or an AI agent — can pull comments
back out, inspect them, and mark them resolved.

Every record is stored under a `fb:<id>` KV key as the original
`FeedbackPayload` **plus** server fields:

```json
{ "status": "open", "received_at": "…ISO…", "resolved_at": null, "resolution_note": null }
```

### One-time setup: the token

The management routes require `Authorization: Bearer <TYREKICK_TOKEN>`. Set
the secret once (any long random string):

```bash
wrangler secret put TYREKICK_TOKEN     # paste e.g. the output of: openssl rand -hex 32
```

Until the secret is set, the management routes answer **401** with
`"TYREKICK_TOKEN not configured"` — they are never open by default. A missing
or wrong token gets **401** `{"ok":false,"error":"unauthorized"}`. Ingest
(`POST /` and `POST /feedback`) never needs the token.

### `GET /feedback` — list comments (newest first)

Optional query params: `status` (`open`|`resolved`), `route` (exact match),
`project` (exact `project_name` match — one Worker can serve many projects),
`since` (ISO timestamp), `limit` (default 50, max 200).

```bash
curl -H "Authorization: Bearer $TYREKICK_TOKEN" \
  "https://tyrekick-feedback.your-subdomain.workers.dev/feedback?status=open&limit=20"
```

Returns `{"ok":true,"count":…,"total":…,"items":[…full records…]}`.

### `GET /feedback/:id` — one full record

```bash
curl -H "Authorization: Bearer $TYREKICK_TOKEN" \
  "https://tyrekick-feedback.your-subdomain.workers.dev/feedback/1a2b3c4d-…"
```

Returns `{"ok":true,"item":{…}}`, or `404` `{"ok":false,"error":"not found"}`
if no such id.

### `PATCH /feedback/:id` — resolve (or reopen) a comment

Body: `{ "status": "resolved" | "open", "note": "optional note" }`. Resolving
sets `resolved_at` + `resolution_note`; reopening clears both. Returns the
updated record. With the Discord tee configured (below), resolved/declined
transitions are also mirrored to the channel (`✅ resolved: …note`), so the
humans who saw the comment arrive also see it close.

### `GET /receipts?ids=<uuid>,<uuid>` — widget closure lookups (no token)

The one deliberately **unauthenticated** read: the widget uses it to turn a
reviewer's pin green after their comment is resolved. Payload ids are
unguessable UUIDv4 capabilities known only to the browser that submitted the
comment; the route accepts exact ids only (batch capped at 50), silently omits
unknown ids, and returns nothing but
`{ id, status, resolved_at, resolution_note }` per hit. It cannot list, search,
or enumerate.

### `GET /` — is this thing on?

The worker is an API, not a website — but the first thing anyone does with a
worker URL is paste it into a browser, so the root answers with a health
summary rather than a bare error:

```bash
curl "$WORKER/"
# {"ok":true,"service":"tyrekick","routes":[…]}
```

Useful as a post-deploy check. It lists route names only (all public knowledge —
this template is open source) and deliberately never reveals whether your
secrets are configured, so it can't be used to probe your setup.

### `GET /shared?project=&route=` — shared review (review key, not the token)

Off unless you opt in. Set the secret and reviewers see **each other's** pins on
the page instead of only their own:

```bash
wrangler secret put TYREKICK_REVIEW_KEY   # e.g. the output of: openssl rand -hex 32
```

Then put the same value on the widget as `data-review-key` (see the
[README](../../README.md#shared-review-reviewers-see-each-other)). The worker
authenticates it via the `X-Tyrekick-Review-Key` header — a header rather than a
query parameter so the key stays out of request logs, referrers, and history.

```bash
curl -H "X-Tyrekick-Review-Key: $TYREKICK_REVIEW_KEY" \
  "$WORKER/shared?project=my-prototype&route=/pricing"
```

**Understand what you are turning on.** The key is embedded in the page you
share, so it is public to everyone holding the review link: anyone who can open
the prototype can read every comment on that project, including reviewer names.
Correct for a private link; wrong for a public URL. Rotate the secret to revoke.

Guard rails, all enforced by the worker:

- Secret unset → `404` (an operator who never opted in does not advertise the
  route). Wrong key → `401`. Missing `project` → `400`; project scope is
  mandatory, so a key for one prototype cannot read another on the same worker.
- **`declined` records are withheld.** Declining a comment therefore removes it
  from every reviewer's page — that is your spam and noise control. The author
  still learns the outcome through `/receipts`, keyed by their own id.
- The response is a **projection**, not the record: it carries `body`,
  `reviewer_name`, `created_at`, `route`, `app_version`, status/note and
  `anchor`. It never carries `env` (user-agent fingerprint), `page_errors`,
  `url` (share links can hold query-string secrets) or `session_id`.
- `TYREKICK_REVIEW_KEY` is read-only and grants nothing on `/feedback`.
  `TYREKICK_TOKEN` stays server-side and must never reach a browser.

## Optional: forward every comment to Discord (tee)

Want the human-friendly channel ping AND the agent-queryable store from one
pin? Add your Discord webhook as a second secret:

```bash
wrangler secret put DISCORD_WEBHOOK    # paste your Discord webhook URL
```

Every successfully stored comment is then also posted to that channel in the
same readable format the widget's `transport: "discord"` uses. Forwarding is
fire-and-forget: a Discord outage, rate limit, or bad URL never affects the
response the reviewer's widget sees, and nothing about the stored record
changes. Leave the secret unset to disable.

With the tee in place, point the widget at the Worker (default
`transport: "json"`) — pointing it straight at Discord instead bypasses
storage, and agents can't read Discord.

```bash
curl -X PATCH \
  -H "Authorization: Bearer $TYREKICK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"resolved","note":"fixed in v1.0.1"}' \
  "https://tyrekick-feedback.your-subdomain.workers.dev/feedback/1a2b3c4d-…"
```

> This REST surface is exactly what the **`tyrekick-mcp`** MCP
> server talks to, so an AI coding agent can list, read, and resolve feedback
> for you — see [`/mcp`](../../mcp/) in the repo.

### Raw KV access (optional)

You can still poke the namespace directly — keys are `fb:<id>`:

```bash
wrangler kv key list --binding FEEDBACK --prefix "fb:"
wrangler kv key get  --binding FEEDBACK "fb:1a2b3c4d-…"
```

> On older Wrangler versions the subcommands are `wrangler kv:key list` /
> `wrangler kv:namespace create` (with a colon). Use whichever your version
> accepts — run `wrangler kv --help`.

---

Prefer feedback to just show up in a chat channel with zero setup? See the
[Discord destination](../discord/README.md).
