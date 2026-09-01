# Troubleshooting & FAQ

## The button doesn't appear

- **Check the script loaded** (Network tab, 200 on `tyrekick.js`) and that
  `data-webhook` *and* `data-app-version` are both present — auto-init logs
  `[Tyrekick] auto-init failed:` to the console when a required attribute is
  missing, and skips silently when `data-webhook` is absent.
- **Strict CSP?** The host page needs `script-src` allowing jsdelivr (or
  self-host the file), and `connect-src` allowing your webhook origin.
  Sandboxed environments that block external POSTs entirely (some AI-artifact
  sandboxes) can't deliver feedback — host the prototype on a normal origin.
- **`init()` called twice?** Second call is a no-op with a console warning;
  call `destroy()` first (SPA hot-reload setups hit this).

## My app is a file, not a hosted page — nothing sends

This is the one setup that can't work as-is. The feedback loop needs the page
to load from an **http(s) origin**. A standalone HTML file — opened via
`file://`, emailed around, or a sandboxed artifact — has no origin, so the
browser blocks the widget's network request and the comment never leaves.
There's also no shared URL to return to, so receipts (the green pin) can't
work either.

The fix is to give the page a home:

- **Deploy it** to any static host (Cloudflare Pages, Netlify Drop, GitHub
  Pages) and share the URL, not the file:
  ```bash
  npx wrangler pages deploy <dir> --project-name <slug> --branch main
  ```
- **Tunnel a local app** if it needs its own server (e.g. Python/Flask):
  ```bash
  npx cloudflared tunnel --url http://localhost:<port>
  ```
- **Serve it locally** if it's just for you — `python3 -m http.server` and use
  the `http://localhost:<port>` URL. **Never `file://`.**
- **Same-origin shortcut:** if your app already serves its own pages (a
  Python/Node server), add a `POST /feedback` route and point the widget at the
  relative `/feedback` — no CORS, and the app itself becomes the destination.

If you use a coding agent, `make-reviewable` handles all of this for you —
it detects an unhosted page and hosts it before wiring the loop. See
[`QUICKSTART`](QUICKSTART.md).

## Comments don't arrive

- **Discord webhook + missing `data-transport="discord"`** is the most common
  cause: raw JSON POSTed to Discord is rejected. The transport is
  auto-detected by `npx tyrekick init`, but manual installs must set it.
- **CORS**: with `transport: "json"`, the destination must answer cross-origin
  POSTs (the Cloudflare template does) — or use a same-origin function path.
- **Your endpoint returns `{"ok":false}`** — Tyrekick treats that as failure
  even on HTTP 200, by contract.
- **`403 {"ok":false,"error":"review_closed"}`** is not an outage. The
  deployment's review window has lapsed and it is refusing new comments on
  purpose. See [below](#this-review-has-closed).
- Delivery has an 8s timeout and one automatic retry after 2s. After final
  failure the reviewer gets Retry / Copy-your-comment, and the unsent comment
  survives reloads (Retry/Discard in the drawer) — so nothing is lost while
  you fix the endpoint.

## "This review has closed"

The composer says `This review has closed — your comment wasn't sent.` when the
worker refuses ingest with `403 {"ok":false,"error":"review_closed"}`. Nothing
is broken: the worker is up, the page is fine, and every comment already
collected is still there. The review window has simply lapsed.

Reviews stand down on purpose. A worker's `wrangler.toml` can carry an optional
`TYREKICK_OPEN_UNTIL` instant, and workers wired by the `make-reviewable` skill
get 14 days by default, so an endpoint nobody is watching stops accepting
anonymous writes instead of staying open forever. Leaving the value empty (the
default in a hand-rolled deploy) means it never closes.

To take another wave of feedback, from the project directory:

```bash
npx tyrekick reopen --days 14   # same URL, same store, same pins
npx tyrekick reopen --never     # remove the window entirely
npx tyrekick close              # stop accepting comments again
```

**The URL never changes.** Closing and reopening edit one config line and
redeploy, so the link you already shared keeps working, and so does everything
except the POST: `GET /feedback`, `/feedback/:id`, `PATCH`, `/receipts` and
`/shared` all keep answering while closed. Your agent can still read and resolve
the backlog of a closed review, and a reviewer's pins still turn green when you
do.

`npx tyrekick status` shows the current state of the project you are in.
`npx tyrekick status --all` lists every deployment this machine has wired, with
a live check on each, which is the fastest way to find old review endpoints you
left open.

One limit worth knowing: the window lives in the project's `wrangler.toml`, so
closing or reopening needs that config on disk. A worker deployed from a
directory you no longer have cannot be closed until you recreate its config
(same worker name and KV id) and deploy that.

## Pins are in the wrong place

Pins re-attach to their element via the stored selector plus the click's
position within it, on every load and window resize. They fall back to raw
page coordinates only when the selector no longer matches — typically after
the page was rebuilt with different markup. Old pins from a heavily changed
build pointing at odd spots is expected; the payload's `element.text` and
`context.heading` still identify what the comment meant.

## What do the colours mean?

Accent badge = delivered. Red badge (pin, drawer entry, or the count on the
drawer toggle) = **not sent yet** — retry or discard it from the drawer or the
pin's own popover. **Green** = resolved (the note is in the tooltip and drawer
entry); **grey** = declined, with its reason. Dimmed pins just mean the widget
is idle; hover or click them any time.

## Where does Tyrekick store things locally?

Only with `persist: true` (default), keyed per page:

- `tyrekick:pins:<pathname>` — failed (undelivered) comments awaiting retry
- `tyrekick:draft:<pathname>` — unsent composer text
- `tyrekick:receipts:<pathname>` — delivered-comment receipts (worker
  transport only): the ids and pin geometry needed to show you what happened
  to your comments. Capped at 50 records / 14 days, pruned automatically.

The destination remains the comments' home — receipts are pointers, not a
shadow copy, and "Got it" (or Retry/Discard for unsent work) cleans the keys
up as you go. `persist: false` reads/writes nothing.

That is everything in the reviewer's browser. On *your* machine the CLI also
keeps `~/.tyrekick/deployments.json`, outside any repo: a bookmark list of the
worker URLs it has wired, so `npx tyrekick status --all` knows what to check. It
holds a URL, a project slug and a date per entry, no tokens and no feedback, and
it is plain JSON you can edit or delete.

## Privacy — what is never captured

Form **values** (for `input`/`textarea`/`select`, element text is always
`null`), keystrokes, screenshots, DOM snapshots, session recordings, cookies.
The console is never patched — `page_errors` comes from `window` error
listeners, capped at 5 × 200 chars, and can be disabled with
`data-capture-errors="false"`. Feedback goes from the reviewer's browser
directly to *your* destination; no third party is in the path.

## SPAs and multi-page prototypes

Each comment records `route` (`pathname+search+hash`) at submit time, so
feedback is always attributable to the right view. On-page pins and unsent
recovery are scoped per `pathname`. One install in the root template covers
the whole app.

## Production / preview gating

Tyrekick is built for review surfaces. To keep it out of production, gate the
tag on your host's env, e.g.:

```js
if (process.env.VERCEL_ENV === "preview") { /* inject the script tag */ }
```

or in a Netlify/Cloudflare Pages build step keyed on `CONTEXT`/branch.

## Isn't my webhook URL exposed?

Yes — by design, and it matters only on public URLs. See
[Destinations → Protecting a public deployment](destinations.md#protecting-a-public-deployment)
for the hosting-based decision table (short version: public URL → use the
worker, never a raw Discord webhook).

## `Authentication error [code: 10000]` when creating the KV namespace

```
✘ [ERROR] A request to the Cloudflare API failed.
  Authentication error [code: 10000]
```

Your Wrangler login is missing the **KV Write** scope. The message names neither
the scope nor the product, and `wrangler deploy` / `wrangler pages deploy` keep
working, so the login looks healthy until you touch storage. D1 and R2 fail the
same way.

Fix it at the source — see
[Cloudflare destination → step 1](../destinations/cloudflare/README.md#1-install-wrangler-and-grant-it-kv-access),
which covers granting the scope or using an API token instead.

One trap while diagnosing: the `scopes` line in Wrangler's
`config/default.toml` records what Wrangler *requested*, not what Cloudflare
granted, so it can list `workers_kv:write` on a login that can't use it. It
isn't evidence either way.

## `wrangler kv namespace create FEEDBACK` says it already exists

```
✘ [ERROR] A KV namespace with the title "FEEDBACK" already exists.
```

Namespace titles are unique per account, so the plain name is taken as soon as
you set up a second project. Name it per project:

```bash
wrangler kv namespace create <project-slug>-FEEDBACK
```

The binding in `wrangler.toml` stays `FEEDBACK` — only the title changes, and
`worker.ts` needs no edit.

## The Pages URL 404s after deploying

If `<project>.pages.dev` returns 404 while `<branch>.<project>.pages.dev` works,
the deploy landed on a **preview** branch. Cloudflare serves the apex domain from
the project's production branch only, and that branch isn't always `main`.

```bash
wrangler pages deployment list --project-name <project>   # Environment column
```

If it says `Preview`, redeploy with `--branch` set to the project's production
branch. This matters for review links: a preview alias works, but it changes per
branch, so the URL you hand reviewers should be the apex one.

## Known limitations

- **No screenshots or session replay** — the structured payload is the
  product; images are deliberately out (bundle stays ~12 KB gzipped,
  dependency-free).
- **Receipts are worker-only** — on Discord destinations there's no read-back,
  so pins can't turn green and delivered comments don't return after reloads.
- **Discord is write-only** — the MCP agent loop needs the worker.
- **Reviews are per-browser** — two reviewers see their own pins, not each
  other's (comments meet at the destination, not on the page).
