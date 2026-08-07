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
- **`Dockerfile`** — multi-stage build producing a small, non-root, fully
  static binary (no CGO — SQLite access is pure Go via `modernc.org/sqlite`).
- **`docker-compose.yml`** — the fastest way to run it, with a named volume
  for the database.

## 1. Run it

```bash
cp .env.example .env    # if you create one — or just export vars directly
export TYREKICK_TOKEN=$(openssl rand -hex 32)
docker compose up -d --build
```

That builds the image, starts the container, and creates a named volume
(`tyrekick-data`) mounted at `/data` inside the container — the SQLite file
lives at `/data/tyrekick.db` and survives `docker compose down` /
`docker compose up` cycles.

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

Until `TYREKICK_TOKEN` is set, the management routes stay closed — same
default-secure posture as the Worker (`wrangler secret put TYREKICK_TOKEN`
there, an env var here).

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
  (`golang.org/x/time/rate`) instead of a Workers Rate Limiting binding. It
  keys on `X-Forwarded-For` / `X-Real-IP` (falling back to the raw connection
  address) rather than Cloudflare's unforgeable `CF-Connecting-IP` — put a
  reverse proxy that sets (and strips any client-supplied copies of) those
  headers in front of this service if you expose it directly to the
  internet.
- **No CORS-vs-same-origin split**: there's no Pages Function mode here; the
  server always sends permissive CORS headers, harmless if you proxy it
  same-origin.
- Everything else — payload validation, the triage ladder, the Discord tee,
  the AI acknowledgement guardrails (capped output, no tools, comment framed
  as untrusted data), the shared-review numbering/withholding rules — is a
  direct port.
