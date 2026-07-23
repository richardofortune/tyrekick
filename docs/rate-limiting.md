# Guide: per-IP rate limiting

**What it does:** caps how many times any single IP can hit your worker's open
routes per minute, so a bot or a viral link can't run up your Cloudflare bill
(KV writes, worker invocations) or flood your store with spam.

**When to use it:** any time your worker URL is public or semi-public. If
you're about to [share a prototype widely](going-public.md), do this first.

**Cost/effort:** two config blocks (already in the template) plus one redeploy.

---

## How it works

Two [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
bindings gate the *open* routes — the token-gated management routes aren't
limited, because the token already gates them:

| Binding | Route(s) | Default | Why |
| --- | --- | --- | --- |
| `INGEST_LIMITER` | `POST /feedback` | 15 / min per IP | The write path — KV writes + stored spam is what actually costs money |
| `READ_LIMITER` | `GET /receipts`, `GET /shared` | 120 / min per IP | Reads/invocations; generous — the widget only polls ~2/min |

Both are **optional** (like the worker's secrets): if the binding isn't
configured, the route just stays open. Both **fail open** — if the limiter
service itself errors, the route keeps working rather than 500-ing real users.
Keyed on `CF-Connecting-IP`, which Cloudflare sets and a client can't forge.

**Caveat:** this is *per-IP*. A botnet spread across many IPs still gets
through — that needs zone-level WAF, which a `*.workers.dev` deployment doesn't
have. Per-IP limiting caps what any single source can cost, which is the common
case.

## Setup

The config already ships in `destinations/cloudflare/wrangler.toml`:

```toml
[[unsafe.bindings]]
name = "INGEST_LIMITER"
type = "ratelimit"
namespace_id = "1001"          # any unique integer per account
simple = { limit = 15, period = 60 }

[[unsafe.bindings]]
name = "READ_LIMITER"
type = "ratelimit"
namespace_id = "1002"
simple = { limit = 120, period = 60 }
```

So enabling it is just a redeploy:

```bash
npx wrangler deploy            # add -c wrangler.local.toml if you deploy with a named config
```

> **Syntax gotcha (this bit us):** the modern top-level `[[ratelimit]]` block is
> only understood by newer wrangler (~4.11+). On **older wrangler (e.g. 4.107)
> it is silently dropped** — you'd deploy with *no* rate limiting and no error.
> The `[[unsafe.bindings]]` form above works on both; "unsafe" here just means
> "a binding wrangler doesn't have first-class config for yet," not that it's
> risky. If you're on new wrangler and prefer the cleaner block, confirm the
> bindings actually appear in `npx wrangler deploy --dry-run` output before
> trusting it. `period` must be `10` or `60`.

## Verify it's enforcing

Against your **deployed** worker, fire more than the limit from one machine
(same IP), and watch the codes flip to `429`:

```bash
WORKER=https://your-worker.workers.dev
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "%{http_code} " -X POST "$WORKER/feedback" \
    -H 'content-type: application/json' \
    -d '{"schema":2,"body":"rate-limit check","project_name":"rl"}'
done; echo
```

You should see `200` fifteen times, then `429`s. A `429` carries
`Retry-After: 60`.

> This writes ~15 real records to your store. Decline or ignore them afterwards
> (via MCP `triage_feedback {status:"declined"}` or just leave them).

## Tune the limits

Edit the `simple = { limit = N, period = 60 }` line for whichever binding and
redeploy. `period` can only be `10` or `60` (seconds).

- A genuine reviewer leaving several comments in a burst might brush 15/min —
  bump `INGEST_LIMITER` to 25–30 if you see legitimate `429`s.
- The read limit rarely matters; 120/min is already far above the widget's
  ~2/min polling.

## Disable

Remove the two `[[unsafe.bindings]]` blocks from your wrangler config and
redeploy. The routes go back to unlimited.

## See also

- [Taking a prototype public](going-public.md) — where this fits in the sequence
- [Destinations](destinations.md#protecting-a-public-deployment) — the broader
  "protecting a public deployment" picture
