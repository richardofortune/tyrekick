# Page password (private staging)

One shared password in front of the hosted prototype. Reviewers type it once,
then use the page as normal. No accounts, no email, nothing stored.

This is a different door from the other two:

| | Gates | Where it lives |
| --- | --- | --- |
| **Page password** (this page) | Who can *see* the prototype at all | The site's own Worker (`tyrekick-gate.js` + a secret) |
| [Review key](shared-review.md) | Who can *read* other reviewers' comments | The feedback worker |
| [Review window](../destinations/cloudflare/README.md#6-close-the-review-when-the-wave-is-over-optional) | Whether new comments are *accepted* | The feedback worker |

Use it when the link is private but guessable: `<name>.<account>.workers.dev`
is a public URL, and a prototype that must not leak wants more than obscurity.
Leave it off for a public share.

**Cloudflare static sites only.** The prototype has to be a Worker with static
assets, which is what `npx wrangler deploy` makes of a folder of HTML (Cloudflare
folded Pages into Workers; `wrangler pages deploy` now creates one of these too).
A tunnel, GitHub Pages or Netlify deploy gets nothing from it. An old
`<slug>.pages.dev` project cannot be locked in place; redeploy the folder with
`wrangler deploy` and share the new URL.

## Turn it on

```bash
npx tyrekick lock --password "<what reviewers type>"
```

Or in one step with the install: `npx tyrekick init … --password "<pw>"`.

`lock` does four things, from the project root:

1. Copies `destinations/cloudflare/pages-gate.js` to `tyrekick-gate.js`.
2. Wires it into `wrangler.jsonc` as the Worker's `main`, with
   `assets.binding: "ASSETS"` and `assets.run_worker_first: true` so every
   request goes through the gate before any file is served. A missing config is
   created (`name` from `--project`, `.tyrekick.json` or the folder name;
   `assets.directory` is the folder your page is in). An existing one keeps
   every other key; comments in it do not survive the rewrite.
3. Sets the password as the `PAGE_PASSWORD` secret (`wrangler secret put`). The
   password is never in the file, the repo or page source. If this step fails,
   `lock` stops before deploying, because the gate fails closed.
4. Runs `npx wrangler deploy`. The lock is live when it prints the URL.

It also writes an `.assetsignore` in the assets folder so the gate, the config
and the usual junk are not uploaded as public files when the page sits at the
project root.

## Turn it off

```bash
npx tyrekick unlock
```

Deletes `tyrekick-gate.js`, takes `main`, `assets.binding` and
`assets.run_worker_first` back out of `wrangler.jsonc`, and deploys. The secret
can stay; nothing reads it.

## How the gate behaves

- Every path is gated, not just HTML. Scripts, images and data files all need
  the cookie.
- The right password sets a 30-day `HttpOnly; Secure; SameSite=Lax` cookie and
  redirects back to the page that was asked for. The cookie value is an HMAC
  keyed on the password, so **changing the password logs everyone out**. There
  is no session store.
- The login page answers `200` and carries the `<title>` and `og:` tags of the
  page behind it, so a shared link still unfurls in Slack or Discord (unfurl
  bots drop non-2xx responses). It is `noindex`, so search engines leave it.
- If the gate is deployed but `PAGE_PASSWORD` is not set, the site answers
  `503 Locked` for everyone. It never fails open.
- A form on your own page that POSTs to the same origin is not mistaken for a
  login: only a form field named `tyrekick_password` is treated as one.

## What it does not do

- It does not protect the feedback worker. The widget talks to the worker
  cross-origin; the page cookie never reaches it. Rate limiting, the review key
  and the review window still do their own jobs.
- It is one shared password, not identity. Anyone you gave it to can pass it
  on. Rotate it (run `lock` again with a new password) to cut them off.
- It does not hide the URL. People can still see there is a locked page there.
