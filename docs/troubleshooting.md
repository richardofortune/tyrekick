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

## Comments don't arrive

- **Discord webhook + missing `data-transport="discord"`** is the most common
  cause: raw JSON POSTed to Discord is rejected. The transport is
  auto-detected by `npx tyrekick init`, but manual installs must set it.
- **CORS**: with `transport: "json"`, the destination must answer cross-origin
  POSTs (the Cloudflare template does) — or use a same-origin function path.
- **Your endpoint returns `{"ok":false}`** — Tyrekick treats that as failure
  even on HTTP 200, by contract.
- Delivery has an 8s timeout and one automatic retry after 2s. After final
  failure the reviewer gets Retry / Copy-your-comment, and the unsent comment
  survives reloads (Retry/Discard in the drawer) — so nothing is lost while
  you fix the endpoint.

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
pin's own popover. Dimmed pins just mean the widget is idle; hover or click
them any time.

## Where does Tyrekick store things locally?

Only with `persist: true` (default), only for unsent work, keyed per page:

- `tyrekick:pins:<pathname>` — failed (undelivered) comments awaiting retry
- `tyrekick:draft:<pathname>` — unsent composer text

Delivered comments are **never** stored locally; the destination is their
home. `persist: false` reads/writes nothing. Clearing: delete those keys, or
just Retry/Discard from the drawer — the keys clean themselves up when empty.

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

## Known limitations

- **No screenshots or session replay** — the structured payload is the
  product; images are deliberately out (bundle stays ~12 KB gzipped,
  dependency-free).
- **No reading feedback back into the widget yet** — reviewers don't see
  resolution status on their pins (planned: capability-based receipts on the
  worker path).
- **Discord is write-only** — the MCP agent loop needs the worker.
- **Reviews are per-browser** — two reviewers see their own pins, not each
  other's (comments meet at the destination, not on the page).
