# Payload reference (schema v2)

With `transport: "json"`, this exact shape POSTs to your webhook
(`FeedbackPayload` in [`src/types.ts`](../src/types.ts) — the canonical
contract; field names never change without a schema bump).

```json
{
  "schema": 2,
  "id": "b1c2…",
  "created_at": "2026-07-02T10:15:30.000+12:00",
  "project_name": "my-prototype",
  "app_version": "3a9c1f2",
  "route": "/pricing?ref=x#plans",
  "url": "https://example.com/pricing?ref=x#plans",
  "body": "This button is hard to find.",
  "reviewer_name": "Sam",
  "session_id": "9f8e…",
  "anchor": {
    "x_pct": 42.3,
    "y_pct": 71.8,
    "selector": "main > section.pricing > button.cta",
    "viewport": { "w": 1440, "h": 900 },
    "element": {
      "tag": "button",
      "id": "buy-now",
      "testid": "pricing-cta",
      "role": null,
      "text": "Start free trial",
      "label": "Start your free trial",
      "rect": { "x": 612, "y": 484, "w": 216, "h": 44 }
    },
    "context": { "heading": "Pricing plans", "landmark": "main > section#pricing" }
  },
  "env": {
    "user_agent": "Mozilla/5.0 …",
    "language": "en-US",
    "screen": { "w": 1512, "h": 982 },
    "dpr": 2,
    "dark": false,
    "touch": false
  },
  "page_errors": ["TypeError: prices is undefined"]
}
```

## Identity & provenance

| Field | Meaning |
| --- | --- |
| `schema` | Always `2`. |
| `id` | UUID per comment. Unguessable — treated as a capability for any future status lookups. |
| `session_id` | UUID minted once per page load; ties comments from one sitting together. |
| `created_at` | ISO-8601 with timezone, at submit time. Retries preserve the original. |
| `project_name` / `app_version` | Your stable project slug + build stamp. Together with `route`, these are how feedback survives URL churn across redeploys. |
| `route` / `url` | `pathname+search+hash` and full `href` where the comment happened. Facts about the moment, not identity. |

## The comment

`body` is the trimmed text (≤2000 chars). Replies made via "Follow up" carry a
`Re #N:` prefix — in the payload only; reviewers see threads, not prefixes.
`reviewer_name` is the optional name field, `null` when empty or disabled.

## `anchor` — where, exactly

- `x_pct` / `y_pct` — percentages of the **document** dimensions at click
  time, 1 decimal place.
- `selector` — best-effort CSS selector of the deepest host-page element at
  the point, max 5 segments, or `null`. Never the widget's own nodes.
- `element` — the source-mapping layer: lowercase `tag`; `id`, `testid`
  (`data-testid`), `role` attributes or `null`; visible `text` (trimmed,
  whitespace-collapsed, ≤80 chars — **the greppable bridge from rendered DOM
  to your source**); `label` (`aria-label` → `alt` → `placeholder` → `title`,
  ≤80 chars); viewport-relative `rect` in integer px. `null` if no element
  resolved. **Privacy: for `input`/`textarea`/`select`, `text` is always
  `null` — form values are never captured.**
- `context` — `heading` is the nearest heading text (h1–h6, walking ancestors
  and preceding siblings, ≤80 chars); `landmark` is a coarse path of up to 3
  landmark ancestors, e.g. `"main > section#pricing"`. Both fail soft to
  `null`; capture never throws.

## `env` and `page_errors`

`env` adds `screen` (physical, CSS px), `dpr` (2 decimals), `dark`
(`prefers-color-scheme`), `touch` (`pointer: coarse`) — enough to tell a
mobile-specific issue from a desktop one. `page_errors` is the last ≤5
uncaught errors / unhandled rejections this page load (each ≤200 chars,
oldest first), via `window` listeners only — the console is never patched.
`[]` when clean or `captureErrors: false`.

## Discord format

With `transport: "discord"` the same information is flattened into a
readable message and POSTed as `{ content }`:

```
**{project_name} {app_version}** — {reviewer_name | Anonymous}
{body}
{selector | x%, y%} · <{url}>
```

## What the worker adds

The [Cloudflare destination](destinations.md) stores the payload verbatim
plus server fields: `status` (`open`/`approved`/`declined`/`resolved`),
`received_at`, `resolved_at`, `resolution_note`. Those never travel through
the reviewer's browser.
