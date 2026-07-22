# The access gate (windows vs sessions)

Tyrekick's [destinations](destinations.md) decide where *feedback goes*. The
**access gate** is a separate, optional layer that decides who can *view the
prototype* at all — useful when the review site is public but only invited
reviewers (and the shared-review pins on it) should be visible.

The implementation is one Cloudflare Pages edge Function:
[`access-gate/cloudflare-pages/`](../access-gate/cloudflare-pages/README.md). It
runs before any page or asset is served, so nothing behind it — including the
embedded review key and reviewers' comments — is returned until the caller is
authenticated.

This page explains the model. The two time concepts, **windows** and **sessions**,
are easy to conflate; keeping them distinct is the whole idea.

---

## Two clocks

### The window — the whole review period

The **window** is the stretch of time the site is open to reviewers at all. It is a
property of the *deployment* — specifically, of whether a valid access code exists —
**not** of any individual person. There is exactly one window, shared by everyone.

- **Opens** when you set the `REVIEW_PASSWORD` secret and deploy.
- **Closes** only when *you* delete or rotate that code and redeploy.
- Nothing closes it automatically. Left alone, the code keeps working indefinitely.

Analogy: an exhibition being open — "the show runs this week."

### The session — one person's logged-in state

A **session** belongs to a single reviewer, in a single browser, and begins the
moment they enter the access code. It is just proof that "this browser already
authenticated," so a reviewer doesn't retype the code on every page load.

- A signed cookie (`tyrekick_review`).
- Lasts **12 hours**, then the reviewer logs in again.
- Everyone gets their own; sessions are independent.

Analogy: a visitor wristband — check in once, good for 12 hours, then check in again.

---

## How they nest

The window is the outer boundary; sessions live inside it.

| State | What the reviewer sees |
| --- | --- |
| Window open, valid session | Straight into the site |
| Window open, session expired (>12h) or never logged in | The Tyrekick login → enter the still-valid code → back in |
| Window **closed** (code deleted) | `503 "This review window is closed."` — for everyone, even mid-session |
| Window **rotated** (new code set) | Every existing session dies instantly; only people given the new code get back in |

The last two rows matter. The session cookie is signed using the **access code as
the HMAC key**, so changing the code mathematically invalidates every existing
session at once — you do not wait for anyone's 12 hours to run out. Closing or
rotating a window is therefore **immediate and total**, whereas an individual
session expiring just sends that one person back to the login while the window
stays open.

---

## Who controls each, and what is enforced

| | Session length (12h) | Window open/close |
| --- | --- | --- |
| **Controlled by** | Configured once (constant in the Function) | You, manually, via `REVIEW_PASSWORD` |
| **Enforced** | Yes — automatically and cryptographically on every request | Only by your manual action |
| **Can a reviewer extend it?** | No — the expiry is signed; editing it breaks the signature and they lack the key | n/a |

The session's 12-hour limit is **not** merely the cookie's `Max-Age` (a client-side
hint a browser could ignore). The cookie value is `<expiry>.<hmac>`, where the
expiry is signed. Each request the Function (a) rejects the token if
`expiry <= now`, and (b) recomputes and constant-time-compares the HMAC. A stale
cookie sent past 12h is rejected server-side.

**The asymmetry to remember:** a session *auto-expires*; a window *does not*. The
only automatic pressure on an abandoned window is that everyone must re-authenticate
every 12h — but the code keeps working, so the door stays open to anyone who has it.

---

## Operating, configuration, security

Commands (open/rotate/close), config vars, local-dev behaviour, and the full list
of security properties live with the implementation:
[`access-gate/cloudflare-pages/README.md`](../access-gate/cloudflare-pages/README.md).
In short: edge-enforced `401`, signed `HttpOnly; Secure; SameSite=Lax` sessions,
constant-time comparisons, fails closed, open-redirect guard, shared-secret model.

> **Deploy gotcha:** `wrangler pages deploy` finds `functions/` relative to the
> current working directory. Deploy from **inside** the deploy dir or the Functions
> bundle is silently skipped and the gate disappears with no error.

---

## Not yet implemented: auto-closing windows (`REVIEW_WINDOW_UNTIL`)

Today a window only closes when you act. To make "open for the week" an *enforced*
guarantee, add a `REVIEW_WINDOW_UNTIL` env var (an expiry timestamp): the Function
would refuse all logins past that moment and show a "this review window has closed"
screen regardless of anyone's session — giving the window the same self-expiring
behaviour a session already has. Noted here as the intended design; not built yet.

---

## Shared secret vs. per-person access

This gate is a **shared-secret** control: one code for everyone in the window, with
no per-person identity, individual revocation, brute-force lockout, or audit log —
the right trade for a short, trusted review window. If you need per-person control
or an audit trail, put **Cloudflare Access** (Zero Trust) in front of the Pages
project instead; it is per-person and revocable, at the cost of a login step and
some setup.
