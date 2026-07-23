# Guide: shared review

**What it does:** turns a review from N private conversations into one shared
page — every reviewer sees every other reviewer's pins (read-only, attributed),
instead of only their own. Reviewers stop reporting the same thing four times.

**When to use it:** a **private** link shared with a handful of people you
trust. **Not** a public URL — see the trade below.

**Cost/effort:** one worker secret + one widget attribute. Worker destination
only (Discord has no read-back).

---

## Read this before you enable it

Shared review works by putting a **review key in your page**, which the widget
sends to the worker to read everyone's pins. Because the key ships in the page,
it is **public to anyone holding the review link**. Enabling shared review
means:

> **Anyone who can open the prototype can read every comment left on it,
> including reviewer names.**

That's the right trade for a private link to people you trust. It's the **wrong
trade for a public URL** (a LinkedIn post, a public demo) — you'd be publishing
your reviewers' feedback, and any spam, to every visitor. On a public share,
leave it off (the default). See [Taking a prototype public](going-public.md).

There's no finer-grained scoping available — reviewers never log in, which is
the whole point of Tyrekick. The key is a door for a private link, not a secret
password.

## Setup (private link)

### 1. Set the key on your worker

```bash
npx wrangler secret put TYREKICK_REVIEW_KEY    # paste `openssl rand -hex 32`
npx wrangler deploy                            # add -c wrangler.local.toml if you use one
```

Until this secret is set, the `/shared` route returns `404` — the feature is off
and doesn't even advertise itself.

### 2. Put the same key on the widget

Auto-init (script tag):

```html
<script
  src="https://cdn.jsdelivr.net/npm/tyrekick@latest/dist/tyrekick.js"
  data-webhook="https://your-worker.workers.dev/feedback"
  data-app-version="v0.1"
  data-project-name="my-prototype"
  data-review-key="the-same-long-random-string"
></script>
```

ESM:

```ts
init({
  webhook: "https://your-worker.workers.dev/feedback",
  appVersion: "v0.1",
  projectName: "my-prototype",
  reviewKey: "the-same-long-random-string",
});
```

The value must match the worker secret exactly.

### 3. Set a stable `projectName`

Shared review is scoped by `projectName`. Use an explicit, stable, kebab-case
value — the same on the widget and across every redeploy. The `document.title`
fallback silently forks your feedback stream the first time you edit the title,
and preview hosts mint a new origin per deploy, so `projectName` is the only
durable identity the shared view has.

## Verify

```bash
WORKER=https://your-worker.workers.dev
KEY=your-review-key

# with the key → 200, your pins:
curl -H "X-Tyrekick-Review-Key: $KEY" "$WORKER/shared?project=my-prototype"
# → {"ok":true,"count":0,"total":0,"pins":[]}

# without the key → 401:
curl -o /dev/null -w "%{http_code}\n" "$WORKER/shared?project=my-prototype"
```

If the secret isn't set you'll get `404` (feature off). Once it's set and the
widget carries the matching `data-review-key`, open the page in two browsers,
comment in one — the pin appears in the other, attributed, within ~60s.

## What reviewers see (and don't)

- Another reviewer's pin renders read-only, labelled with their name (or
  "Another reviewer" if they left the name blank). You can reply, but replies go
  to your destination like any comment — not peer-to-peer.
- **Declined comments are withheld** from the shared view. Declining a comment
  (via MCP or the API) is therefore how you clear spam and noise from
  *everyone's* page. Its author still learns the outcome on their own pin.
- Other reviewers never see your user agent / device fingerprint, the page's
  errors, the full URL (share links can carry query secrets), or your session
  id — the `/shared` response is a deliberate projection.

## Revoke or disable

Rotate or delete the worker secret — no page edit needed:

```bash
npx wrangler secret put TYREKICK_REVIEW_KEY    # new value → old links can't read
# or
npx wrangler secret delete TYREKICK_REVIEW_KEY # feature off entirely
npx wrangler deploy
```

## See also

- [Taking a prototype public](going-public.md) — why this stays off for public URLs
- [Configuration](configuration.md) — the `reviewKey` / `data-review-key` field
- [AI auto-reply](ai-auto-reply.md) — keeping shared review off is what keeps AI
  replies author-only
