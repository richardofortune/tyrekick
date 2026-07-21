# Destinations

Feedback POSTs straight from the reviewer's browser to a destination **you**
own. There is no Tyrekick backend and nothing phones home.

The two destinations play different roles: **Discord shows you it works in 60
seconds; the worker is the actual loop.** Discord is the taster — instant,
zero-build proof that feedback surfaces somewhere you own. The Cloudflare
Worker is where the product lives: persistence, statuses, and the
[MCP agent loop](agent-loop.md). Start with whichever matches your moment,
but know which one you're on.

## Discord webhook (the 60-second taster)

**Best for:** seeing feedback flow immediately; localhost, tunnels,
screen-shares — anywhere the URL isn't sitting in public.

1. Discord → **Server Settings → Integrations → Webhooks → New Webhook** →
   pick a channel → **Copy Webhook URL**.
2. Use it with `data-transport="discord"`.

Each comment arrives as a readable message:

```
**my-prototype 3a9c1f2** — Sam
The hero copy is unclear
main > section#hero button.cta · <https://deploy-abc.example.app/>
```

**Limitations to know:** Discord is write-only — there is no reading feedback
back, so the [MCP agent loop](agent-loop.md) does not work on this path. And
the webhook URL is visible in your page source, which is fine on a private
URL and a spam cannon on a public one. When you want the loop, move to the
worker — it takes minutes and the widget change is one attribute.

> **Best of both:** the worker can mirror every ingested comment to a Discord
> channel — set the optional secret and Discord becomes a notification view on
> top of the worker rather than a separate destination:
>
> ```bash
> wrangler secret put DISCORD_WEBHOOK
> ```
>
> Forwarding is fire-and-forget: a Discord outage never affects the ingest
> response the widget sees. Humans get the ping; agents keep the queryable
> store — and when a comment is resolved or declined, the closure is mirrored
> to the channel too (`✅ resolved: … — note`), so the loop closes in front of
> everyone who watched it open.

## Cloudflare Worker (the actual loop)

**Best for:** the real workflow — owned storage, statuses, agent access.
Required for MCP, and for anything on a public URL.

The deployable TypeScript template lives in
[`destinations/cloudflare`](../destinations/cloudflare):

```bash
cd destinations/cloudflare
wrangler deploy
wrangler secret put TYREKICK_TOKEN   # mints the management token
```

Point the widget at it (plain `transport: "json"`):

```html
data-webhook="https://tyrekick-feedback.YOUR.workers.dev/feedback"
```

The worker validates payloads, truncates oversized bodies, and stores each
record in KV with server fields: `status` (`open` → `approved`/`declined` →
`resolved`), `received_at`, `resolved_at`, `resolution_note`.

### REST surface

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /feedback` | none | Ingest (reviewers stay frictionless) |
| `GET /feedback?status=&route=&project=&since=&limit=` | Bearer token | List, newest first (`limit` default 50, max 200) |
| `GET /feedback/:id` | Bearer token | Full single record |
| `PATCH /feedback/:id` | Bearer token | `{ status, note? }` — walk the triage ladder |
| `GET /receipts?ids=…` | none (capability ids) | Widget closure lookups — exact payload-UUIDs only, batch ≤50, returns status/when/note and nothing else. This is what turns a reviewer's pin green. |

Auth is `Authorization: Bearer <TYREKICK_TOKEN>`; wrong/missing token → 401.
One worker serves many projects — records are filterable by `project`
(which is why a [stable `projectName`](configuration.md) matters).

### The status ladder

`open` (untriaged) → `approved` | `declined` → `resolved`. Reviewers never see
triage state; it exists so agents and owners can agree on what gets acted on —
see [review modes](agent-loop.md#review-modes).

## Same-origin function

If the prototype is on Cloudflare Pages (or anything with serverless
functions), a same-origin endpoint (e.g. `/api/feedback`) avoids CORS
entirely — set `webhook` to the relative URL. Any CORS-enabled JSON endpoint
works too: with `transport: "json"`, success is HTTP 2xx and a body that
isn't `{"ok":false}`.

## Shared review

By default each reviewer sees only their own pins — comments meet at your
destination, not on the page. Setting a **review key** flips that: everyone sees
everyone's pins, read-only and attributed, so nobody reports the same thing
four times.

Worker destination only (Discord is write-only). Two matching values:

```bash
wrangler secret put TYREKICK_REVIEW_KEY    # on your worker
```

```html
<script … data-project-name="my-prototype" data-review-key="the-same-value"></script>
```

**The trade, stated plainly:** that key ships in your page source, so it is
public to anyone holding the review link. Turning this on means *anyone who can
open the prototype can read every comment left on it, including reviewer names.*
There is no finer-grained scoping available — reviewers never log in, which is
the point of the tool. So:

- **Private link to people you trust:** the trade is fine. This is the case it
  was built for.
- **Genuinely public URL:** leave it off. You would be publishing your
  reviewers' comments to strangers, and any spam that arrives becomes visible
  to every visitor rather than just to you.

Declining a comment withdraws it from everyone's page, which is the moderation
lever if noise does arrive. Rotate the worker secret to revoke access entirely.
Full route details in
[`destinations/cloudflare`](../destinations/cloudflare/README.md).

## Protecting a public deployment

The webhook URL ships in page source **by design** — Tyrekick refuses to
proxy your feedback through servers you don't control. The consequences
scale with your hosting:

- **Private URL (localhost/tunnel):** nothing to do.
- **Public preview URL:** use the worker, not raw Discord. The worker URL is
  public but holds no secret; the management token never leaves your side.
- **Genuinely public site:** the worker template is yours — add rate limiting
  per IP, an origin allowlist, and body caps there. The `open → approved`
  triage ladder already functions as a moderation queue: agents in shared
  review only act on what you approve, so junk ingest costs you a glance,
  not a bad change.

Never "fix" webhook visibility by routing through a third party — that
reintroduces exactly the middleman Tyrekick exists to remove.
