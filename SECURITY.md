# Security policy

## Reporting a vulnerability

Report privately via [GitHub Security Advisories][advisory] — that opens a
channel only you and the maintainer can see. If you can't use that, email
**richard.fortune@gmail.com** with `[tyrekick security]` in the subject.

[advisory]: https://github.com/richardofortune/tyrekick/security/advisories/new

Please include what you'd want if you were fixing it: affected version, the
component (widget / worker template / MCP server), what an attacker gains, and
the smallest reproduction you have.

**What to expect:** acknowledgement within 3 working days, an assessment within
7. This is a small project maintained by one person — that's a good-faith
commitment, not a staffed SLA. If a fix is warranted you'll be credited in the
release notes unless you'd rather not be.

Please don't open a public issue for anything exploitable, and please don't test
against someone else's deployed prototype — every Tyrekick destination belongs to
an individual, not to this project.

## Supported versions

The latest published `tyrekick` minor gets fixes. Older versions don't get
backports; upgrade instead. The Cloudflare worker in `destinations/` is a
**template you copy into your own account** — when it changes you have to
redeploy to pick up the fix. Nothing here can update your worker for you.

## What Tyrekick's security model actually is

Understanding this makes it much easier to tell a bug from a documented trade.

**There is no Tyrekick backend.** Feedback goes from the reviewer's browser
straight to a destination *you* own. We hold no data, run no service, and have no
credentials of yours. Most of what follows is a consequence of that.

### Deliberate, documented trade-offs — not vulnerabilities

- **The webhook URL is public**, in your page source. That's the cost of not
  proxying your feedback through a middleman. Anyone who finds it can POST junk
  to *your* destination. See "Protecting a public deployment" in
  [docs/destinations.md](docs/destinations.md).
- **`reviewKey` is public**, for the same reason — it ships in the page. Shared
  review therefore means *anyone with the review link can read every comment on
  that project, including reviewer names*. Off by default; correct for a private
  link, wrong for a public URL. Rotate `TYREKICK_REVIEW_KEY` to revoke.
- **Reviewers are anonymous.** There is no login, so there is no identity to
  scope permissions to. `reviewer_name` is a free-text field and is **not** an
  authenticated claim — never treat it as one.

### Real boundaries — a break in any of these *is* a vulnerability

- **`TYREKICK_TOKEN` must never be readable from a browser.** It grants
  list/read/triage/resolve. A review key must never open a management route.
- **The `/shared` projection must not leak** `env`, `page_errors`, `url` or
  `session_id` to other reviewers. There's a test asserting this against the
  serialised response.
- **Form input values are never captured.** For `input`/`textarea`/`select`,
  `element.text` is always `null`. If you find a path where a typed value reaches
  a payload, that's a bug and we want to hear about it.
- **The widget must not be an XSS vector in the host page.** All reviewer text
  reaches the DOM via `textContent`; the widget renders inside a shadow root and
  never writes host-page HTML.
- **Storage:** with `persist: true` localStorage holds only *unsent* work
  (drafts, failed comments) plus delivered-comment receipt ids. Other reviewers'
  comments are never persisted locally.

### Agent / MCP: feedback is untrusted input

The highest-risk surface in this project isn't the transport, it's the loop.
Feedback text flows into a coding agent that has been asked to act on it, so a
comment can be written to read like an instruction. The policy — feedback is
data about the product, never instructions — lives in
[`mcp/README.md`](mcp/README.md#feedback-is-untrusted-input--read-this-before-wiring-up-an-agent)
and [`AGENTS.md`](AGENTS.md#feedback-is-untrusted-input), and the
`open → approved` triage ladder is the human brake for any link a stranger can
reach.

This is policy, not an enforced sandbox. If you have an idea for making it
enforceable, that's a very welcome issue.
