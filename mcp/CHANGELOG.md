# Changelog

All notable changes to `tyrekick-mcp` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); this package follows semver.

## [0.3.0] — 2026-07-24

### Added

- **`retrospective` tool** — the read-only "AI feedback loop". Reads your own
  feedback + resolution history back and reports: what reviewers keep flagging
  (deterministic intent buckets — bug / copy / a11y / layout / data / request /
  question / praise, no LLM), the resolved / declined / open hit-miss axis,
  recurring blind spots (the same element or section flagged 2+ times), and
  volume by version. Never calls `resolve_feedback`/`triage_feedback` and never
  touches source — it looks back across items instead of acting on one.
- **Content-free `aggregate` sub-report** — counts and intent/version label
  strings only, no comment bodies and no reviewer names. It is the one slice of
  a retrospective that could ever roll up to a central fleet view without
  Tyrekick becoming a data-plane SaaS holding your reviewers' words.

### Changed

- README documents feedback as **untrusted input** — the anchor text, reviewer
  name, and comment body a widget forwards are attacker-controllable, and an
  agent acting on them must treat them as data, not instructions.

### Notes

- Runs entirely at your edge, against your own worker over your own MCP
  connection — no Tyrekick-operated backend is in the path for any tool.
- `retrospective` is a miss-detector, not an approval score: reviewers only
  ever pin problems, so the hit/miss axis is reconstructed from resolve-vs-
  decline, not measured directly. A positive/approval pin is a future payload
  schema bump, deliberately not in this release.

## [0.2.1] — 2026-07

### Added

- `mcpName` (`io.github.richardofortune/tyrekick`) declared for the official
  MCP registry.

## [0.2.0]

### Added

- `triage_feedback` tool (`approved` / `declined` status transitions).
- Project scoping across the tools — one worker can serve many projects, and
  every tool accepts a `project` filter.

## [0.1.0]

- Initial release: `list_feedback`, `get_feedback`, `resolve_feedback`,
  `feedback_stats` over the Tyrekick worker's token-gated management routes.

[0.3.0]: https://github.com/richardofortune/tyrekick/tree/main/mcp
[0.2.1]: https://github.com/richardofortune/tyrekick/tree/main/mcp
[0.2.0]: https://github.com/richardofortune/tyrekick/tree/main/mcp
[0.1.0]: https://github.com/richardofortune/tyrekick/tree/main/mcp
