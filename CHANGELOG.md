# Changelog

Notable changes to the `tyrekick` widget. The MCP server (`tyrekick-mcp`) is
versioned separately; see [`mcp/`](mcp/).

## Unreleased

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
