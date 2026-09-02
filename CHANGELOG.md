# Changelog

Notable changes to the `tyrekick` widget. The MCP server (`tyrekick-mcp`) is
versioned separately; see [`mcp/`](mcp/).

## 0.8.0

- **A review can stand down.** A review link is not one-shot: feedback comes in
  waves, and between waves a worker deployed for one afternoon's prototype keeps
  accepting anonymous writes from anyone who still has the URL. The only way to
  stop that was to delete the worker, which also deletes every comment in it.

  The worker gained one optional wrangler `[vars]` entry,
  `TYREKICK_OPEN_UNTIL`, an ISO-8601 instant after which `POST` ingest answers
  `403 {"ok":false,"error":"review_closed","open_until":"…"}` before it reads
  the body. It is a var rather than a secret because it is readable on purpose,
  and it fails open in every unclear case: absent, empty or unparseable all mean
  the review never closes. So a typo can fail to close a review and can never
  silently shut a live one, and every worker deployed before this release
  behaves exactly as it does today, redeployed or not.

  Closing gates ingest and nothing else. The URL does not move, the page still
  loads, and `GET /feedback`, `/feedback/:id`, `PATCH`, `/receipts` and
  `/shared` all keep answering, so your agent still pulls the full history out
  of a closed project and reviewers' pins still turn green as you resolve their
  comments. Reopening bumps the instant and redeploys: same worker name, same KV
  namespace, same link.

  New commands: `npx tyrekick close`, `npx tyrekick reopen --days 14` (or
  `--never`), and `npx tyrekick status --all`, which lists every deployment this
  machine has wired and probes each one live for whether it is still open. That
  list is bookmarked in `~/.tyrekick/deployments.json`, outside any repo, three
  fields per entry: worker URL, project slug, date added. No tokens, no webhook
  URLs, no cached state, so nothing in it can go stale or leak.

  The widget adds no requests. It learns a review is closed from the 403 rather
  than probing on load, which would tax every load of every open review to
  improve the rare closed one. `transport/webhook.ts` now returns the
  destination's typed `error` instead of a bare boolean, so the composer can say
  "This review has closed — your comment wasn't sent." with the Copy button and
  no dead Retry, and a restored failed pin's drawer button reads "Review closed"
  instead of offering a retry that cannot succeed. Retry behaviour is unchanged
  for every other kind of failure.

  Workers wired by the `make-reviewable` skill now get a 14-day window by
  default. Existing workers keep no window until you set one. Redeploy from
  `destinations/cloudflare/worker.ts` to get the gate; the widget change alone
  does nothing.

- **`remove --teardown` deletes `.tyrekick.json`.** The per-deployment pointer file
  was written at spin-up but nothing in the CLI knew it existed, so a thorough
  teardown could delete the worker, the KV namespace, the Pages project and the MCP
  registration, and still leave behind a file naming all four. A plain `remove`
  keeps it and says so, because the worker and its feedback are still live.

- **`status --all` shows the unread count per deployment**, and `--open` lists the
  comments under each with their ids. The window probe stays unauthenticated so a
  worker whose token this machine never held still lists; its count shows `—`, which
  means "not known", never zero. Tokens come from the environment only
  (`TYREKICK_TOKEN_<project>`, then `TYREKICK_TOKEN`) — the registry holds no secrets.

- **`status` finds the widget that `init` installed.** `init --file` accepts any
  path, but every later command re-guessed from four conventional names, so a
  project whose page is not `index.html` was told its install was missing — and
  Worker, link preview and review state all went blank with it. `init` now records
  the path in `.tyrekick.json` and `findWidget()` reads it first, falling back to
  the conventional names when the recorded file no longer holds a tag.

- **`status` recognises a per-project MCP server.** One machine holds many of these
  and they cannot all be called `tyrekick`, so the check now tries the documented
  name and then `tyrekick-<project>`, reports which one answered, and `remove`
  unregisters the name that actually exists rather than assuming the default.

- **Connectivity checks no longer count as feedback.** `tyrekick init` and the
  make-reviewable skill each post one comment to prove the destination works, and
  storing those as "open" left them in the queue forever. Nobody saw that until
  now, because until now nothing counted an open queue; it matters because
  `status --all` above does. They now carry `kind: "verification"` and land
  already resolved, still mirrored to Discord but never counted as something a
  person said. Payloads without the field are unchanged.

  Existing stores still hold theirs. On an account with seventeen workers, sixteen
  of thirty-one open comments were the tooling talking about itself, and seven
  projects reported a backlog no human had written. Resolve them once and the
  counts are honest from then on.

## 0.7.0

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
