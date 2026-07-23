# Guide: AI auto-reply

**What it does:** when a reviewer leaves a comment, the worker asks Claude Haiku
for **one short, friendly acknowledgement** and shows it in that reviewer's own
comment thread, labelled 🤖. It makes a public share feel like someone's
listening — without you watching in real time.

**When to use it:** any public or semi-public share where you want reviewers to
feel acknowledged. It's off by default and safe to leave on.

**Cost/effort:** one worker secret + a redeploy + one spend limit. Bounded to
cents.

---

## What it is — and deliberately isn't

It is a **mouth, not hands**. The model call has **no tools**, so a comment can
make it *say* something, never *do* anything:

- **No tools** — it can only emit text. A malicious comment can't make it fix,
  delete, deploy, or call anything. This is the load-bearing safety property.
- **Acknowledges, never promises.** It describes what you pinned; it never says
  a fix is coming and never claims anything changed. The **pin stays open** —
  an AI reply is a thread message, never a fake "resolved" green.
- **Author-only.** The reply rides the per-author `/receipts` capability, so
  with [shared review](shared-review.md) **off** (as it must be on a public
  URL), each reply is seen only by the person who wrote the comment. Even if
  someone crafted a comment to make the reply say something odd, only they'd
  see it.
- **Off by default.** It runs only when `ANTHROPIC_API_KEY` is set on the
  worker.

### Cost, bounded three ways

- **Cheap model:** `claude-haiku-4-5`, capped at `max_tokens: 120` → roughly
  **0.15¢ per reply**. The comment body is already truncated to 2,000
  characters, so input is capped too — a "reply with 5,000 words" injection
  still produces ≤120 tokens.
- **Daily cap:** a global counter (`AI_DAILY_CAP = 500` replies/day, in
  `worker.ts`) stops generation once hit — worst case ~75¢/day.
- **Spend limit (you set this):** an Anthropic **workspace spend limit** is the
  hard account-level ceiling. The daily cap is an app-level soft guard, not a
  substitute — set both.

## Setup

### 1. Set the key on your worker

```bash
npx wrangler secret put ANTHROPIC_API_KEY      # paste an Anthropic API key
npx wrangler deploy                            # add -c wrangler.local.toml if you use one
```

Get a key at [console.anthropic.com](https://console.anthropic.com). Until this
secret is set, the feature is completely dormant.

### 2. Set an Anthropic spend limit

In the Anthropic console, set a **workspace spend limit** (e.g. $5/month). This
is the hard backstop the in-app daily cap can't provide — even a bug or a
determined abuser across many IPs physically can't exceed it.

### 3. Keep shared review off (on a public URL)

This isn't a separate step so much as a reminder: author-only replies depend on
[shared review](shared-review.md) being off. On a public page, it already
should be.

## Verify

Leave a comment through the widget on your page. The widget polls `/receipts`
about once a minute, so within ~60 seconds (or immediately when you open the
comment drawer) the 🤖 acknowledgement appears in your own comment thread. The
pin stays its normal open colour — no green.

To check the worker side directly:

```bash
WORKER=https://your-worker.workers.dev

# submit a comment, capture its id
ID=$(curl -s -X POST "$WORKER/feedback" -H 'content-type: application/json' \
  -d '{"schema":2,"id":"'"$(uuidgen | tr A-Z a-z)"'","body":"what does this button do?","project_name":"test"}' \
  | sed 's/.*"id":"\([^"]*\)".*/\1/')

sleep 5   # generation is async (fire-and-forget after ingest)

curl -s "$WORKER/receipts?ids=$ID"
# → {"ok":true,"receipts":[{"id":"…","status":"open","ai_reply":"Thanks — I can see you pinned the button…"}]}
```

If `ai_reply` is `null`, either the key isn't set, the daily cap is spent, or
the model call failed (all fail silently by design — a missing reply is never an
error).

## Tune

Both are edits in `destinations/cloudflare/worker.ts`, then redeploy:

- `const AI_DAILY_CAP = 500;` — the global daily reply ceiling.
- `max_tokens: 120` — how long a reply can be (also your injection cost cap).

The reply's tone lives in the system prompt in the same file (`AI_SYSTEM_PROMPT`)
if you want to adjust the voice.

## Disable

```bash
npx wrangler secret delete ANTHROPIC_API_KEY
npx wrangler deploy
```

Replies stop immediately. Existing stored replies remain on their records but no
new ones are generated.

## See also

- [Taking a prototype public](going-public.md) — where this fits in the sequence
- [Shared review](shared-review.md) — why keeping it off is what makes replies
  author-only
- [The agent loop](agent-loop.md) — the difference between this (a bounded
  acknowledgement) and pointing a real fixing agent at feedback
