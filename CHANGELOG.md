# Changelog

Notable changes to the `tyrekick` widget. The MCP server (`tyrekick-mcp`) is
versioned separately; see [`mcp/`](mcp/).

## Unreleased

- **`init --url <url>` writes `og:url`.** 0.5.0 omitted it because `init` cannot
  know the deploy URL, and that is still true — nothing guesses one. But without
  `og:url` a crawler treats a preview subdomain and the production alias as two
  different pages, so the same review link unfurls inconsistently depending on
  which address someone pasted. If you already know where the page will live,
  pass it by hand and `init` writes the canonical tag. It is validated before
  anything is written: absolute `http(s)`, a hostname with a dot (so `localhost`
  is refused), no credentials, fragment dropped, and a bare host read as
  `https://` — a typo fails the command rather than pointing every unfurl at the
  wrong page, and fails early enough to leave no half-finished install. On a page
  that already has `og:` tags but no `og:url`, `--url` adds just that one line;
  everything the author set is still left alone. The flag is opt-in and typed by
  hand; without it, behaviour is unchanged.

## 0.6.0

- **Comment numbers stop moving.** A pin's number was a count taken over
  whatever was on screen when the page drew, recomputed on every refresh. So
  declining one comment shifted every later comment down by one, and switching
  shared review on renumbered a reader's own pins the moment other people's
  arrived. That matters more than it sounds: reviewers quote numbers to each
  other, and the widget freezes one into the `Re #N:` prefix of every reply at
  send time — text that reaches the worker, Discord and the MCP listing and is
  never rewritten. Once numbering shifted, that stored text pointed at the wrong
  comment, with nothing to signal it.

  `/shared` now assigns the number and returns it as `n`, derived from the
  page's whole history ordered by `created_at` with `id` breaking ties. It
  counts declined records too, so removing a comment leaves a gap instead of
  renumbering its neighbours — a gap says something was removed, where a
  renumber silently rewrites what a quoted number means. Nothing is stored and
  no counter is needed, so there is no atomic-increment problem: the ordering
  comes from data already on the record.

  The widget prefers the assigned number and counts only comments the
  destination has never seen, placing those above every assigned number so the
  two schemes cannot collide. Workers older than this release send no `n` and
  readers fall back to counting exactly as before. Numbers are deliberately not
  added to `/receipts`, which is contractually a non-listing capability lookup;
  a reviewer with no review key keeps insertion-order numbering.

  Redeploy your worker from `destinations/cloudflare/worker.ts` to get it — the
  widget change alone does nothing.

## 0.5.0

- **A shared review link now unfurls as an invitation, not a bare URL.** The
  review URL gets pasted into Slack or Discord, and that paste is the ask — but
  a generated prototype rarely has Open Graph tags, so the unfurl was a bare
  hostname that reads like a broken link. `init` now adds a minimal preview
  (`og:title`, `og:description`, `twitter:card`) derived from the page's own
  `<title>` and meta description. It only ever **adds**: a page that already has
  `og:` tags is left alone and reported. `--no-preview` skips it. `og:url` and
  `og:image` are deliberately not written, because `init` knows neither the
  deploy URL nor an image, and a wrong canonical URL is worse than none.
  `tyrekick status` gained a **Link preview** row reporting what a paste will
  actually show, and flagging the missing image that separates a card from a
  line of text.

## 0.4.0

Published without a changelog entry at the time; written up retrospectively by
checking the published tarball, so these are the changes that are already in
`tyrekick@0.4.0` rather than pending ones.

- **SPA route changes reset per-route pins.** Pin/draft/receipt storage is keyed
  by `location.pathname`, but `restore()` only ran once at `init()`, so on a
  client-routed app (history.pushState, no reload) the previous view's pins
  lingered over the next route. The widget now follows navigation (wrapped
  `pushState`/`replaceState` + `popstate`) and, on a real pathname change, tears
  down the old pins, reloads storage for the new route, and reprojects — reverted
  cleanly in `destroy()`. Query/hash-only changes are ignored.
- **CLI grows a management surface.** Bare `npx tyrekick` now opens a
  zero-dependency, arrow-key **management menu** with a live status dashboard
  (widget / worker / MCP). New subcommands:
  - `status` — one-shot dashboard.
  - `disable` / `enable` — remove or restore the widget while leaving the
    worker, token, MCP registration, and **all feedback data** untouched
    (reversible; the exact tag is stashed in `.tyrekick.disabled`).
  - `remove` — uninstall local wiring (strip the tag + `claude mcp remove`),
    keeping cloud data by default; `remove --teardown` additionally deletes the
    Cloudflare worker + KV + token secret, guarded by a type-the-project-name
    confirmation because it destroys all feedback.
  - `init` is unchanged. CLI logic split into `bin/lib.mjs` + `bin/tui.mjs`.
- **Framework-aware detection.** `status`/`disable`/`remove` now also detect a
  framework/ESM install (the `import { init } from "tyrekick"` mount) — reporting
  the file:line and reading config from the `init({…})` call. Because that mount
  lives in user-owned source, the CLI gives precise removal guidance rather than
  auto-editing framework code (which could break the build).

## 0.3.2

- **Receipts — closure reaches the reviewer.** A resolved comment's pin turns
  green with the resolution note; declined comments go grey with their reason.
- Worker `GET /receipts` — unauthenticated capability-id status lookups so the
  widget can pull fix-status back without accounts.
- Worker mirrors resolved/declined transitions to Discord when the tee is set.
- `localStorage` widened (only) to persist delivered-comment receipts, still
  gated by `persist` and capped in count/age.

## 0.3.1

- `make-reviewable` skill: one-sentence setup that picks a destination for your
  hosting, deploys the worker, installs the widget, wires MCP, and drafts the
  ask (later extended to host an unhosted app/artifact).
- CLI derives its version and CDN pin from `package.json` (no more drift).
- Contract/config housekeeping.

## 0.3.0

- **Stable pin identity** (uuid + `replyToId`) with threaded replies,
  decoupled from display numbers.
- **Unsent-work recovery**: `localStorage` narrowed to unsent work; failed
  comments come back after reload with Retry/Discard in the drawer.
- **Anchor re-projection**: pins re-attach to their element across viewport
  changes and reloads.
- **Interactive pins**: persistent presence, hover tooltips, click-to-thread
  popover, reply-in-place highlight, hide-pins toggle.
- Draft-safe Esc (only Cancel discards) and Cmd/Ctrl+Enter to send.

## 0.2.0

- Comment drawer, draft recovery, schema-v2 payload (element text / heading /
  landmark / env / page errors — the agent source-mapping layer), Discord +
  Cloudflare Worker destinations, `tyrekick-mcp` read-back.

## 0.1.0

- Initial release: pin-a-comment widget, webhook delivery, zero backend.
