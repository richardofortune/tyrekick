# Access gate — control who can view the review site

Tyrekick's [destinations](../destinations/README.md) control where *feedback goes*.
The **access gate** controls who can *view the prototype* in the first place —
useful when the review site is on a public URL but you only want invited reviewers
(and the shared-review pins on the page) to be visible.

It's optional, self-contained, and keeps Tyrekick's zero-backend posture: no
accounts, no third party, nothing phones home.

| Implementation | For | Notes |
|---|---|---|
| [Cloudflare Pages](./cloudflare-pages/README.md) | Prototypes hosted on Cloudflare Pages | One edge `functions/_middleware.js`, a shared access code, a Tyrekick-branded login |

## Windows vs sessions

The gate has two time concepts, and keeping them distinct is the whole model:

- A **window** is the shared review period — open while an access code exists,
  closed the moment you remove it. It never expires on its own.
- A **session** is one reviewer's 12-hour logged-in state — a signed, per-browser
  cookie that auto-expires.

Rotating the access code closes the window *and* invalidates every session at once
(the code is the session-signing key). Full explanation, including the state matrix
and what is enforced vs. manual, is in [`docs/access-gate.md`](../docs/access-gate.md).

## When to reach for Cloudflare Access instead

This is a **shared-secret** gate: one code for everyone, no per-person revocation
or audit trail — the right trade for a short, trusted review window. If you need
per-person identity, individual revocation, or an audit log, use Cloudflare Access
(Zero Trust) in front of the Pages project instead.
