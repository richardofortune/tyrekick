# Page password (private staging)

One shared password in front of the hosted prototype. Reviewers type it once,
then use the page as normal. No accounts, no email, nothing stored.

This is a different door from the other two:

| | Gates | Where it lives |
| --- | --- | --- |
| **Page password** (this page) | Who can *see* the prototype at all | The Pages site (`_worker.js` + a Pages secret) |
| [Review key](shared-review.md) | Who can *read* other reviewers' comments | The feedback worker |
| [Review window](../destinations/cloudflare/README.md#6-close-the-review-when-the-wave-is-over-optional) | Whether new comments are *accepted* | The feedback worker |

Use it when the link is private but guessable: `<slug>.pages.dev` is a public
URL, and a prototype that must not leak wants more than obscurity. Leave it off
for a public share.

**Cloudflare Pages only.** It uses the Pages `_worker.js` hook, which runs in
front of every request to the site. A tunnel, GitHub Pages or Netlify deploy
gets nothing from it, and `lock` says so rather than pretending.

## Turn it on

```bash
npx tyrekick lock --password "<what reviewers type>"
# then redeploy the same folder
npx wrangler pages deploy <dir> --project-name <slug> --branch <production-branch>
```

Or in one step with the install: `npx tyrekick init … --url https://<slug>.pages.dev/ --password "<pw>"`.

`lock` does two things:

1. Copies `destinations/cloudflare/pages-gate.js` to `_worker.js` next to your
   page. Pages runs that file for every request. Without a valid cookie it
   answers with a small password form instead of the page.
2. Sets the password as the `PAGE_PASSWORD` secret on the Pages project
   (`wrangler pages secret put`). The password is never in the file, the repo
   or page source.

The Pages slug comes from the `--url` you gave `init`, or from `.tyrekick.json`
if the skill wrote one. Pass `--project <slug>` if it cannot tell.

## Turn it off

```bash
npx tyrekick unlock     # deletes _worker.js
# redeploy
```

The secret can stay; nothing reads it once the file is gone.

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
- If the file is deployed but `PAGE_PASSWORD` is not set, the site answers
  `503 Locked` for everyone. It never fails open.
- A form on your own page that POSTs to the same origin is not mistaken for a
  login: only a form field named `tyrekick_password` is treated as one.

## What it does not do

- It does not protect the feedback worker. The widget talks to the worker
  cross-origin; the page cookie never reaches it. Rate limiting, the review key
  and the review window still do their own jobs.
- It is one shared password, not identity. Anyone you gave it to can pass it
  on. Rotate it (run `lock` again) to cut them off.
- It does not hide the Pages URL. People can still see there is a locked page
  there.
