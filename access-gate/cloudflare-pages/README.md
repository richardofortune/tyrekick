# Cloudflare Pages access gate

A single edge Function that gates a Pages-hosted prototype behind a shared access
code, showing a consistent Tyrekick-branded login. Zero dependencies, zero backend
— the same posture as the rest of Tyrekick.

Use it when your review site is on a **public** URL and you want only invited
reviewers to see it (and, by extension, the shared-review pins on it). It pairs
with — it does not replace — the ingest protection in
[`docs/destinations.md`](../../docs/destinations.md): that guards where *feedback
goes*; this guards who can *view the page*.

## Install

1. Copy [`functions/_middleware.js`](functions/_middleware.js) into your Pages
   project's deploy directory at **`functions/_middleware.js`**.
2. Set the access code (production environment):
   ```bash
   printf '%s' "<your-access-code>" | npx wrangler pages secret put REVIEW_PASSWORD --project-name <project>
   ```
3. Deploy — **from inside the deploy directory** (see the gotcha below):
   ```bash
   cd <deploy-dir> && npx wrangler pages deploy . --project-name <project> --branch main
   ```
   Confirm the output shows `Compiled Worker successfully` + `Uploading Functions bundle`.

Share the access code with reviewers out-of-band. They enter it once on the
Tyrekick screen and are in for a 12-hour session.

> **Deploy gotcha:** `wrangler pages deploy` discovers the `functions/` folder
> relative to the **current working directory**, not the asset-dir argument. Deploy
> from the project root and the Functions bundle is **silently skipped** — the gate
> vanishes with no error. Always `cd` into the deploy dir first.

## Operating windows

```bash
# Open / rotate a window (rotating the code kills all existing sessions)
printf '%s' "<code>" | npx wrangler pages secret put REVIEW_PASSWORD --project-name <project>
cd <deploy-dir> && npx wrangler pages deploy . --project-name <project> --branch main

# Close a window (site then returns 503 for everyone)
npx wrangler pages secret delete REVIEW_PASSWORD --project-name <project>
cd <deploy-dir> && npx wrangler pages deploy . --project-name <project> --branch main
```

## Configuration (Pages env, production)

| Var | Required | Purpose |
| --- | --- | --- |
| `REVIEW_PASSWORD` | Yes | Shared access code. Absent ⇒ the gate fails **closed** (503). Also the HMAC key for sessions, so rotating it invalidates all sessions. |
| `REVIEW_PROJECT` | No | Small label shown on the login screen. |
| `REVIEW_GATE` | No | `off` disables the gate — **local dev only**, via a local `.dev.vars` file (never deployed). |

## Local development

The gate is an edge Function, so a plain local server (`python3 -m http.server`,
your app's dev server) never runs it — **local-only URLs have no login,
automatically.** The exception is `wrangler pages dev`, which does run Functions;
there, put `REVIEW_GATE=off` in a local-only `.dev.vars` file.

The gate deliberately does **not** bypass on the `Host` header — that is spoofable
and must never be a way around a security control.

## Security properties

- **Edge-enforced** — a real `401` before any HTML is served; not a client overlay.
- **Signed sessions** — cookie is `<expiry>.<HMAC-SHA256(expiry, access-code)>`,
  flags `HttpOnly; Secure; SameSite=Lax; Path=/`. The expiry is signed, so it can't
  be extended; tampering fails verification.
- **Constant-time comparisons** for both the code and the session signature.
- **Fails closed** — no `REVIEW_PASSWORD` ⇒ everyone gets 503.
- **Open-redirect guard** — the post-login `next` must be a same-origin path.
- **Shared-secret model, by design** — one code per window; no per-person identity,
  individual revocation, brute-force lockout, or audit log. Right for a short,
  trusted review window; for per-person control or an audit trail, use Cloudflare
  Access instead.

See [`docs/access-gate.md`](../../docs/access-gate.md) for the full windows-vs-sessions model.
