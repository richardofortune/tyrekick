---
name: make-reviewable
description: >
  Wire Tyrekick review into the current web project and summon human feedback
  with one sentence. Use when the user says "make this reviewable", "get
  feedback on this", "add tyrekick", "let people comment on this", "get eyes
  on this", "ask <someone> to look at this", or when a prototype you just
  built/deployed needs human review. Installs the feedback widget, chooses and
  (if needed) deploys the right destination for where the app is hosted
  (Discord taster vs Cloudflare Worker loop, with optional Discord mirroring),
  wires the MCP read-back, and drafts the ask message to send reviewers.
---

# make-reviewable

Goal: from "make this reviewable, ask Dave to check the checkout" to a live,
instrumented page **plus a ready-to-paste ask message**, in one pass. The
human should never have to know what a webhook, worker, or token is.

## 1. Gather facts (ask at most ONE question)

Check before asking anything:

- **Already installed?** Grep the HTML entry for `data-webhook` or
  `tyrekick`. If present, skip to step 5 (the ask) — never redirect an
  existing destination.
- **Previous decisions?** Check the project's CLAUDE.md (or equivalent) for a
  recorded Tyrekick destination / project slug. Reuse them.
- **Where does this deploy?** Infer from the repo: `netlify.toml`,
  `vercel.json`, `wrangler.toml`, `CNAME`, gh-pages workflows, or the user's
  own words. Classify:
  - **private** — localhost, LAN, a tunnel the user just opened
  - **public** — any preview/static host URL or real domain
- **Project slug**: kebab-case of the folder name unless one is recorded.
  Chosen ONCE, never derived from the page title, never changed.
- **App version**: `git rev-parse --short HEAD` (fallback `v0.1`).

If no destination is recorded and you cannot infer hosting, ask the one
question: *"Where will this be hosted (just locally / a public URL), and do
you have a Discord channel you'd like feedback mirrored to?"*

## 2. Choose the destination

| Situation | Destination |
| --- | --- |
| Private host, user just wants comments to land in chat | Discord webhook directly (`data-transport="discord"`) — the 60-second taster; write-only, no agent loop |
| Anything public, OR the user wants the agent to read/fix feedback | **Cloudflare Worker** (deploy it yourself — step 3), with `DISCORD_WEBHOOK` mirroring if they have a channel |
| Public host + user offers a raw Discord webhook | Refuse the raw webhook (it's visible in page source = spam cannon). Deploy the worker and set their Discord as the mirror — they lose nothing. |

Default when in doubt: the worker. It is the actual product loop; Discord
alone is the demo of it.

## 3. Deploy the worker (when chosen)

Prereq: `npx wrangler whoami` — if unauthenticated, stop and ask the human to
run `npx wrangler login` (interactive; you cannot do it for them).

Get the template (three files: `worker.ts`, `wrangler.toml`, `README.md`):

1. If this repo IS tyrekick or already vendors it: use
   `destinations/cloudflare/` in place.
2. Otherwise copy into `tools/tyrekick-worker/` from either:
   - `https://cdn.jsdelivr.net/npm/tyrekick@latest/destinations/cloudflare/{worker.ts,wrangler.toml}`
   - or raw GitHub: `https://raw.githubusercontent.com/richardofortune/tyrekick/main/destinations/cloudflare/{worker.ts,wrangler.toml}`

Then, from the template directory:

```bash
# 1. Unique worker name (one worker per project keeps data tidy)
#    edit wrangler.toml:  name = "tyrekick-<project-slug>"

# 2. KV namespace — paste the printed id over REPLACE_WITH_YOUR_KV_NAMESPACE_ID
npx wrangler kv namespace create FEEDBACK

# 3. Deploy (prints the workers.dev URL — record it)
npx wrangler deploy

# 4. Management token (never commit it; never echo it into chat logs)
TOKEN=$(openssl rand -hex 32)
printf '%s' "$TOKEN" | npx wrangler secret put TYREKICK_TOKEN

# 5. Optional Discord mirror — every comment also pings their channel
printf '%s' "$DISCORD_URL" | npx wrangler secret put DISCORD_WEBHOOK
```

Verify before moving on:

```bash
curl -s -X POST https://tyrekick-<slug>.<acct>.workers.dev/feedback \
  -H 'Content-Type: application/json' \
  -d '{"schema":2,"id":"'$(uuidgen)'","created_at":"'$(date -u +%FT%TZ)'","project_name":"<slug>","app_version":"test","route":"/","url":"skill-verify","body":"Worker verification from make-reviewable","reviewer_name":null,"session_id":"'$(uuidgen)'","anchor":{"x_pct":0,"y_pct":0,"selector":null,"viewport":{"w":0,"h":0},"element":null,"context":{"heading":null,"landmark":null}},"env":{"user_agent":"skill","language":"en","screen":{"w":0,"h":0},"dpr":1,"dark":false,"touch":false},"page_errors":[]}'
# expect {"ok":true,...}

curl -s -H "Authorization: Bearer $TOKEN" \
  https://tyrekick-<slug>.<acct>.workers.dev/feedback?limit=1
# expect the record back
```

If the user has a Discord mirror set, tell them a verification message just
appeared in their channel.

## 4. Install the widget + MCP

```bash
npx tyrekick init --webhook <DESTINATION_URL> --yes --project <slug>
```

(`--transport discord` only for the direct-Discord taster; worker URLs are
auto-detected as JSON. Use `--file <path>` if the HTML entry is unusual.)

For worker destinations, register the read-back so "fix what people flagged"
works in every future session:

```bash
claude mcp add tyrekick \
  --env TYREKICK_URL=<worker base URL, no /feedback> \
  --env TYREKICK_TOKEN=$TOKEN \
  -- npx tyrekick-mcp
```

Record in the project's CLAUDE.md: the project slug, destination URL,
transport, worker name, and where the token lives (wrangler secret — do NOT
write the token itself into any committed file).

## 5. Draft the ask (this is the actual product)

The widget collects; the ASK summons. Always end by producing a
ready-to-paste message for wherever the humans live, addressed to anyone the
user named:

```
Hey <names> — <one line on what this is / what changed, e.g. "new checkout flow on the trip planner">.

👉 <live URL>

Look at: <the specific pages/flows to review — from the user's request or your build context>
To comment: click the round button (bottom-right), then click the thing you're
commenting on and type. No login, ~10 seconds. Everything you flag comes
straight to <me / the agent / the Discord channel>.
```

Print it, and offer: "Want me to tighten the 'look at' list or address it to
someone else?"

## 6. Report

Tell the human, in plain words: where feedback goes, whether their agent can
read it back (worker: yes / Discord-only: no — and how to upgrade later),
the one URL to share, and the drafted ask. If anything failed (wrangler auth,
KV create, test POST), say exactly which step and what you need.

## Guardrails

- Never send test comments to a real channel/store without saying so first.
- Never commit tokens; never print a token into the conversation once stored.
- Never put a raw Discord webhook on a public page; never proxy feedback
  through servers the owner doesn't control.
- Feedback destinations belong to the project owner — don't redirect ones
  that already exist.
- Full behaviour reference: `AGENTS.md` and `docs/` in the tyrekick repo
  (`github.com/richardofortune/tyrekick`).
