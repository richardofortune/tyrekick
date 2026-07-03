# Tyrekick

**Kick the tyres before you ship it.** Tyrekick is the feedback loop for AI-built prototypes: reviewers pin comments directly on the live page — no account, no training — and your coding agent pulls them back over MCP with the exact element, its visible text, the section heading, and any page errors attached. The agent fixes what was flagged and marks it resolved. You never retype feedback into a prompt again.

```
 reviewer's browser              destination YOU own              your coding agent
┌──────────────────┐   POST    ┌────────────────────┐    MCP    ┌─────────────────┐
│ pin a comment on │ ────────► │ Discord webhook or │ ◄───────► │ "fix the open   │
│ the live page    │           │ your CF Worker     │           │  feedback"      │
└──────────────────┘           └────────────────────┘           └─────────────────┘
```

The widget is a single ~8 KB script with zero dependencies, rendered in Shadow DOM so it can't fight your page. There is no Tyrekick backend, no accounts, and nothing phones home — feedback POSTs straight from the reviewer's browser to a destination **you** own. It exists for the moment an agent-built prototype needs more than one pair of eyes: instead of pasting screenshots into group chats and losing the replies, every comment arrives structured, versioned, and pinned to the exact spot.

Reviewers also get a comment drawer (a right-hand panel listing every pin with its text — click one to jump back to that spot), draft recovery, and full keyboard/touch support. With `persist: true` (the default) pins survive reloads.

> **Agents:** installing Tyrekick into a project? Read [`AGENTS.md`](AGENTS.md) — it has the exact steps.

<!-- TODO: record demo/index.html flow as docs/demo.gif -->

## 60-second quickstart (Discord)

The fastest path is a Discord channel you control.

1. In Discord, open **Server Settings → Integrations → Webhooks → New Webhook**, pick a channel, and **Copy Webhook URL**.
2. Paste that URL into the snippet below and drop it before `</body>` on your prototype:

```html
<script
  src="https://cdn.jsdelivr.net/npm/tyrekick@latest/dist/tyrekick.js"
  data-webhook="https://discord.com/api/webhooks/XXXX/YYYY"
  data-app-version="v0.1"
  data-transport="discord"
  data-project-name="My Prototype"
  data-accent="#4f46e5"
  data-position="bottom-right"
  data-branding="true"
></script>
```

The IIFE build auto-initialises from its own `<script>` tag's `data-*` attributes on `DOMContentLoaded`. Reviewers get a "Give feedback" button in the corner; each comment lands in your Discord channel as a readable message.

> Only `data-webhook` and `data-app-version` are required. Everything else is optional and falls back to the defaults in the [configuration table](#configuration).

## Self-hosting / owned storage

Discord is the frictionless default, but if you want the data in storage you own, use a JSON transport (`transport: "json"`, the default) pointed at an endpoint that persists the payload.

- **Cloudflare template (TypeScript):** see [`destinations/cloudflare`](destinations/cloudflare) for a deployable Worker that receives the [v2 payload](#payload-schema-v2), validates it, and writes it to storage you control. It's a good place to add spam validation since the code is yours.
- **Same-origin Pages Function:** if your prototype is hosted on Cloudflare Pages, drop a Pages Function at the same origin (e.g. `/api/feedback`) and set `webhook` to that relative/same-origin URL. Same-origin means no CORS setup at all.

Any CORS-enabled endpoint or form backend works too — with `transport: "json"`, success is HTTP 2xx and, if a body is returned, it is not `{"ok":false}`.

## The agent loop (MCP)

The reason Tyrekick exists. With the Cloudflare Worker destination, feedback isn't just collected — your coding agent can **pull it, act on it, and resolve it**:

1. Deploy the worker and set a token (see [`destinations/cloudflare`](destinations/cloudflare)):
   ```bash
   wrangler deploy && wrangler secret put TYREKICK_TOKEN
   ```
2. Give your agent the pipeline (once — it works for every future session):
   ```bash
   claude mcp add tyrekick \
     --env TYREKICK_URL=https://tyrekick-feedback.YOUR.workers.dev \
     --env TYREKICK_TOKEN=your-token \
     -- npx tyrekick-mcp
   ```
3. Close the loop with one sentence:
   > *"List the open feedback and fix what people flagged, then resolve it."*

The agent gets four tools — `list_feedback`, `get_feedback`, `resolve_feedback`, `feedback_stats` — and each item carries the element's visible text (greppable in your source), the nearest heading, the route, the viewport, and any uncaught page errors. A comment like *"this button does nothing"* arrives as:

```
element: <button> "Search trips"
under: "Plan your escape" · landmark: main > section#planner
page_errors: 1
> This button does nothing when I click it
```

That's a better bug report than most humans write. Full details in [`mcp/README.md`](mcp/README.md).

## Programmatic / ESM usage

Install from your registry and initialise explicitly (the ESM build does **not** auto-init):

```bash
npm install tyrekick
```

```ts
import { init, destroy } from "tyrekick";

init({
  webhook: "https://discord.com/api/webhooks/XXXX/YYYY",
  appVersion: "v0.1",
  projectName: "My Prototype",
  transport: "discord",
});

// later, to tear down all DOM, listeners, and in-memory state:
destroy();
```

The global (IIFE) equivalent is `window.Tyrekick.init(config)` / `window.Tyrekick.destroy()`. Calling `init()` twice without `destroy()` is a no-op and warns; a missing `webhook` or `appVersion` throws.

## Configuration

Every field of `TyrekickConfig` (see [`src/types.ts`](src/types.ts)):

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `webhook` | `string` | **yes** | — | Destination URL that receives the POST. |
| `appVersion` | `string` | **yes** | — | Version string of the prototype under review. |
| `projectName` | `string` | no | `document.title` | Human label for the project. |
| `position` | `"bottom-right" \| "bottom-left"` | no | `"bottom-right"` | Trigger button corner. |
| `accent` | `string` | no | `"#4f46e5"` | Trigger + pin colour. |
| `branding` | `boolean` | no | `true` | Show the "Built by Frontier Operations" footer. |
| `fields` | `{ name?: boolean }` | no | `{ name: true }` | Toggle the optional reviewer-name input. |
| `transport` | `"json" \| "discord"` | no | `"json"` | How the payload is delivered (raw JSON vs. Discord message). |
| `persist` | `boolean` | no | `true` | Use `localStorage` for draft recovery and to keep this session's pins across reloads. No storage keys are read/written when `false`. |
| `captureErrors` | `boolean` | no | `true` | Record the page's uncaught errors / unhandled rejections (via `window` `"error"` and `"unhandledrejection"` listeners — the console is never patched) and attach the last ≤5 to each payload as `page_errors`. Set `data-capture-errors="false"` on the script tag for the auto-init build. Input **values** are never captured anywhere, regardless of this flag. |

## Payload schema (v2)

With `transport: "json"`, the raw body POSTed to your `webhook` is exactly this shape (`FeedbackPayload`):

```json
{
  "schema": 2,
  "id": "b1c2...",
  "created_at": "2026-07-02T10:15:30.000+12:00",
  "project_name": "My Prototype",
  "app_version": "v0.1",
  "route": "/pricing?ref=x#plans",
  "url": "https://example.com/pricing?ref=x#plans",
  "body": "This button is hard to find.",
  "reviewer_name": "Sam",
  "session_id": "9f8e...",
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
    "context": {
      "heading": "Pricing plans",
      "landmark": "main > section#pricing"
    }
  },
  "env": {
    "user_agent": "Mozilla/5.0 ...",
    "language": "en-US",
    "screen": { "w": 1512, "h": 982 },
    "dpr": 2,
    "dark": false,
    "touch": false
  },
  "page_errors": ["TypeError: prices is undefined"]
}
```

Field notes:

- `schema` is always `2`. `id` and `session_id` are UUIDs (`id` per comment, `session_id` once per page load).
- `created_at` is ISO-8601 with timezone. `route` is `location.pathname + search + hash`; `url` is `location.href`.
- `body` is the trimmed comment text; `reviewer_name` is `string | null`.
- `anchor.x_pct` / `anchor.y_pct` are percentages of the **document** dimensions at click time, to 1 decimal place. `anchor.selector` is a best-effort CSS selector (max 5 segments) of the deepest host-page element at the point, or `null` — never the widget's own nodes.
- `anchor.element` identifies the clicked element so a coding agent can map feedback back to source: lowercase `tag`, `id` / `data-testid` (`testid`) / `role` attributes (or `null`), visible `text` (trimmed, whitespace collapsed, ≤80 chars, `null` if empty), `label` (`aria-label` → `alt` → `placeholder` → `title`, ≤80 chars), and the viewport-relative bounding `rect` in integer px at click time. It is `null` when no element could be resolved. **Privacy:** for `input`/`textarea`/`select`, `text` is always `null` — form values are never captured.
- `anchor.context` places the click structurally: `heading` is the text of the nearest heading (`h1`–`h6`, walking ancestors and their preceding siblings, ≤80 chars) and `landmark` is a coarse path of up to 3 landmark ancestors (`main`, `nav`, `header`, `footer`, `aside`, `section`, `article`, `form`), innermost last, e.g. `"main > section#pricing"`. Both are `null` when nothing is found; capture never throws.
- `env` adds the physical `screen` size (CSS px), `dpr` (`devicePixelRatio`, 2 decimals), `dark` (`prefers-color-scheme: dark`) and `touch` (`pointer: coarse`).
- `page_errors` is the last ≤5 uncaught errors / unhandled promise rejections seen this page load (each ≤200 chars, oldest first), collected via `window` listeners — the console is never patched. `[]` when there were none or `captureErrors: false`.

With `transport: "discord"`, this payload is instead formatted into a readable Discord message (`{ content }`) and that is POSTed.

## Limitations

This is deliberately a one-way, zero-backend tool. That comes with tradeoffs:

- **No threaded replies.** Feedback is fire-and-forget; there's no conversation in the widget.
- **No reading feedback back into the widget.** Comments go out to your destination; they are never fetched or displayed in the overlay.
- **No screenshots or session replay.** Only the JSON payload above is sent — no images, no DOM capture, no recording.
- **Spam.** A public webhook can receive junk — that's the tradeoff for having no backend and no gatekeeper. Mitigate it by pointing `transport: "json"` at the [Cloudflare template](destinations/cloudflare) and adding validation/rate-limiting there, or by sending to a **private** Discord channel that only your reviewers can reach.

## Contributing

```bash
npm run build   # build dist/tyrekick.js (IIFE) + dist/tyrekick.esm.js (ESM)
npm test        # unit tests (vitest)
npm run e2e     # end-to-end tests (playwright)
```

Please keep `src/types.ts` as the single source of truth — don't rename payload keys or config fields without a schema bump.

## Built by [Frontier Operations](https://frontierops.dev)

Tyrekick exists as a brand vehicle for [Frontier Operations](https://frontierops.dev): a genuinely useful, open tool that makes gathering feedback on a prototype frictionless while proving a principle we care about — your reviewers' comments never route through us. There's no Frontier backend in the loop and nothing phones home; feedback goes from the reviewer's browser straight to a destination you own. Useful software, given away, that quietly demonstrates how we think about building.
