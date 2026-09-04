# Self-hosted destination (Go + SQLite, Docker)

A self-hosted, single-container port of the [Cloudflare Worker
destination](../cloudflare/README.md). Same REST contract — same routes, same
JSON shapes, same `{"ok":true,...}` envelope — so the widget, the
[`tyrekick-mcp`](../../mcp/) server, and anything else built against the
Cloudflare Worker work against this unchanged. The only thing that moves is
where it runs and where the data lives: a Go binary instead of a Worker,
SQLite on a mounted volume instead of Workers KV.

Pick this over the Cloudflare destination if you'd rather run your own
container (on a VPS, a homelab box, Kubernetes, Fly.io, Railway, ...) than
use Cloudflare's platform, or if you want the feedback data to live on disk
you control.

Files in this folder:

- **`main.go`, `handlers.go`, `store.go`, `types.go`, `middleware.go`,
  `discord.go`, `ai.go`, `uuid.go`** — the server. `store.go` is the SQLite
  layer (schema + queries); `handlers.go` is the HTTP routes and their logic,
  ported one-for-one from `../cloudflare/worker.ts`.
- **`*_test.go`** — the suite CI runs (`go test -race ./...`). Beyond the
  usual coverage it pins the behaviours that must not drift from
  `worker.ts`: the routing table, the triage transitions, what `/shared`
  withholds, and the numbering gap a declined comment leaves behind.
- **`Dockerfile`** — multi-stage build producing a small, non-root, fully
  static binary (no CGO — SQLite access is pure Go via `modernc.org/sqlite`).
- **`docker-compose.yml`** — the fastest way to run it, with a named volume
  for the database.

## 1. Run it

```bash
export TYREKICK_TOKEN=$(openssl rand -hex 32)
docker compose up -d --build
```

That builds the image, starts the container, and creates a named volume
(`tyrekick-data`) mounted at `/data` inside the container — the SQLite file
lives at `/data/tyrekick.db` and survives `docker compose down` /
`docker compose up` cycles.

`docker-compose.yml` reads `TYREKICK_TOKEN` from the environment or from a
`.env` file next to it, and refuses to start without one. Compose picks up
`.env` automatically, so this works too:

```bash
echo "TYREKICK_TOKEN=$(openssl rand -hex 32)" > .env
```

The published port is bound to `127.0.0.1` — see [Exposing it to the
internet](#exposing-it-to-the-internet) before you change that.

Check it's alive:

```bash
curl http://localhost:8080/
# {"ok":true,"service":"tyrekick","routes":[...]}
```

### Without Docker

```bash
go build -o tyrekick-server .
TYREKICK_TOKEN=$(openssl rand -hex 32) DB_PATH=./tyrekick.db ./tyrekick-server
```

## 2. Point the widget at it

```js
Tyrekick.init({
  webhook: "http://your-host:8080",
  appVersion: "1.0.0",
  // transport: "json"  // default — no need to set it
});
```

Behind a reverse proxy (Caddy, nginx, Traefik) terminating TLS, point the
widget at that proxy's HTTPS URL instead — the server itself speaks plain
HTTP.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `DB_PATH` | `/data/tyrekick.db` | SQLite file path — point this at your mounted volume |
| `TYREKICK_TOKEN` | *(unset)* | Bearer token for the management routes (`GET`/`PATCH /feedback...`). Unset = those routes answer `401` for everyone, exactly like the Worker |
| `DISCORD_WEBHOOK` | *(unset)* | Optional Discord webhook URL — tees every stored comment (and resolve/decline) to a channel |
| `TYREKICK_REVIEW_KEY` | *(unset)* | Optional key enabling `GET /shared` (reviewers see each other's pins). Same trust model as the Worker — see [the Worker README](../cloudflare/README.md#get-sharedprojectroute--shared-review-review-key-not-the-token) |
| `ANTHROPIC_API_KEY` | *(unset)* | Optional — enables the one-sentence AI acknowledgement (`ai_reply`), via Claude Haiku |
| `AI_DAILY_CAP` | `500` | Global ceiling on AI acknowledgements generated per UTC day |
| `INGEST_RATE_LIMIT` / `INGEST_RATE_PERIOD_SECONDS` | `15` / `60` | Per-IP limit on `POST /feedback` (the write path). Set the limit to `0` to disable |
| `READ_RATE_LIMIT` / `READ_RATE_PERIOD_SECONDS` | `120` / `60` | Per-IP limit on `GET /receipts` and `GET /shared`. Set the limit to `0` to disable |
| `TRUST_PROXY` | `false` | Whether to believe `X-Forwarded-For` / `X-Real-IP` when keying the rate limiters. Set to `true` **only** behind a reverse proxy you control — see below |

Until `TYREKICK_TOKEN` is set, the management routes stay closed — same
default-secure posture as the Worker (`wrangler secret put TYREKICK_TOKEN`
there, an env var here).

### Exposing it to the internet

The Worker keys its rate limiters on `CF-Connecting-IP`, which a client
cannot forge because Cloudflare sets it at the edge. Nothing here has an
edge, so the equivalent headers — `X-Forwarded-For`, `X-Real-IP` — are
ordinary request headers that any client can send.

That makes `TRUST_PROXY` a real fork in the deployment, not a tuning knob:

- **`TRUST_PROXY=false` (default).** Rate limits key on the connection's peer
  address. Correct when this server accepts connections directly. Behind a
  proxy it is merely useless — every request appears to come from the proxy,
  so the whole world shares one bucket.
- **`TRUST_PROXY=true`.** Rate limits key on the first `X-Forwarded-For`
  entry. Correct **only** if a proxy you control terminates every request and
  *overwrites* that header rather than appending to a client-supplied one. If
  a client can reach this server without passing through that proxy, it can
  mint a fresh rate-limit key per request and the limiter stops existing.

So: put Caddy/nginx/Traefik in front, bind this server to loopback (the
shipped `docker-compose.yml` does), and set `TRUST_PROXY=true`. Caddy's
`reverse_proxy` and nginx's `proxy_set_header X-Forwarded-For $remote_addr`
both overwrite correctly.

Rate limiting is a cost ceiling on a single source, not a DDoS defence —
distributed abuse across many real IPs still gets through, on this
destination exactly as on the Worker.

## Endpoints

Identical to the Worker — see [the full writeup in
`../cloudflare/README.md`](../cloudflare/README.md#reading-feedback-back-rest-api)
for request/response details. Summary:

| Route | Auth | Purpose |
|---|---|---|
| `POST /` , `POST /feedback` | open (rate-limited) | Ingest a `FeedbackPayload` |
| `GET /` | none | Health check |
| `GET /feedback` | Bearer token | List, newest first (`status`, `route`, `project`, `since`, `limit`) |
| `GET /feedback/:id` | Bearer token | One full record |
| `PATCH /feedback/:id` | Bearer token | Triage: `{"status": "...", "note": "..."}` |
| `GET /receipts?ids=` | none (rate-limited) | Widget closure lookups by capability id |
| `GET /shared?project=&route=` | `X-Tyrekick-Review-Key` header | Every reviewer's pins for one project |

```bash
curl -H "Authorization: Bearer $TYREKICK_TOKEN" \
  "http://localhost:8080/feedback?status=open&limit=20"
```

This is the exact surface `tyrekick-mcp` talks to — point it at this server
with `TYREKICK_URL=http://your-host:8080` instead of a `workers.dev` URL and
everything (list/read/resolve from an AI agent) works unchanged.

## Data & backups

Everything lives in one SQLite file at `DB_PATH` (WAL mode, so you'll also
see `-wal` / `-shm` files next to it while the server is running — normal,
not corruption). To back it up:

```bash
# Cleanest: ask SQLite for a consistent snapshot rather than copying the
# raw file while the server might be mid-write.
docker exec <container> sqlite3 /data/tyrekick.db ".backup /data/backup.db"
docker cp <container>:/data/backup.db ./tyrekick-backup-$(date +%F).db
```

To inspect the database directly (the self-hosted equivalent of the Worker
README's "Raw KV access" section — the image ships the `sqlite3` CLI for
this):

```bash
docker exec -it <container> sqlite3 /data/tyrekick.db \
  "SELECT id, status, route, created_at FROM feedback ORDER BY created_at DESC LIMIT 20;"
```

### Bind mount instead of a named volume

If you'd rather have the SQLite file directly visible on the host:

```yaml
volumes:
  - ./data:/data
```

The container runs as a non-root user (`tyrekick`); a fresh host directory is
owned by whoever created it, so pre-create and `chown` it to match, e.g.:

```bash
mkdir -p ./data && sudo chown 100:101 ./data   # adjust to the image's uid:gid
```

A named volume (the default in `docker-compose.yml`) avoids this because
Docker initializes it from the image's `/data` ownership on first creation.

## Differences from the Cloudflare Worker

- **Storage**: SQLite file instead of Workers KV. Filtering (`status`,
  `route`, `project`, `since`) is done with real SQL `WHERE` clauses instead
  of the Worker's list-metadata-then-fetch-bodies two-phase read — simpler
  and strongly consistent, since there's no distributed KV eventual
  consistency to work around locally.
- **Rate limiting**: an in-process per-IP token bucket
  (`golang.org/x/time/rate`) instead of a Workers Rate Limiting binding, and
  it needs to be told where the client's address comes from — see [Exposing
  it to the internet](#exposing-it-to-the-internet). The bucket map is capped,
  so a flood of distinct addresses degrades to a shared bucket rather than
  growing without bound.
- **AI budget**: the daily cap is exact here. The Worker's counter is a KV
  read-modify-write, so a burst can overshoot; SQLite reserves a slot and
  returns the new count in one statement, and hands the slot back if the
  generation fails.
- **AI write-back**: the acknowledgement is patched onto the stored record
  in place (`json_set`), so a triage `PATCH` that lands while the model is
  generating survives. The Worker rewrites the whole record because KV has no
  partial update.
- **No CORS-vs-same-origin split**: there's no Pages Function mode here; the
  server always sends permissive CORS headers, harmless if you proxy it
  same-origin.
- Everything else — payload validation, the triage ladder, the Discord tee,
  the AI acknowledgement guardrails (capped output, no tools, comment framed
  as untrusted data), the shared-review numbering/withholding rules — is a
  direct port.
