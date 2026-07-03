# Discord destination (zero-code default)

This is the easiest way to receive feedback: comments arrive as messages in a
Discord channel. There is **no server to run and nothing to deploy**. Discord's
webhook endpoints send permissive CORS headers, so the reviewer's browser can
POST directly to Discord from any origin.

## 1. Create a Discord webhook

You need "Manage Webhooks" permission on the server (server owners have it).

1. Open **Discord** and go to the server where you want feedback to land.
2. Click the server name → **Server Settings**.
3. In the left sidebar, choose **Integrations**.
4. Click **Webhooks**.
5. Click **New Webhook**.
6. Give it a name (e.g. "Tyrekick") and, under **Channel**, choose the
   channel the comments should post to (e.g. `#prototype-feedback`).
7. Click **Copy Webhook URL**. It looks like:

   ```
   https://discord.com/api/webhooks/123456789012345678/AbCdEf...long-token...
   ```

8. Click **Save Changes**.

> Treat this URL like a password. Anyone who has it can post to that channel.
> If it leaks, delete the webhook (step above) and create a new one.

## 2. Point the widget at it

Paste the copied URL as the widget's `webhook`, and set `transport: "discord"`.

**JavaScript config:**

```js
Tyrekick.init({
  webhook: "https://discord.com/api/webhooks/123456789012345678/AbCdEf...",
  appVersion: "1.0.0",
  transport: "discord",
});
```

**Or the zero-JS `data-*` form (IIFE build):**

```html
<script
  src="https://your-host/dist/tyrekick.js"
  data-webhook="https://discord.com/api/webhooks/123456789012345678/AbCdEf..."
  data-app-version="1.0.0"
  data-transport="discord"
></script>
```

That's it. Reload the prototype, click "Give feedback", drop a pin, and submit.

## 3. What an incoming comment looks like

Each submission posts one chat message to the chosen channel. The widget formats
the payload into a readable line, for example:

```
**Checkout Prototype 1.0.0** — Sam Rivera
The "Pay now" button is below the fold on mobile.
12.4%, 63.1% · <https://proto.example.com/checkout>
```

Reading it top to bottom:

- **`Checkout Prototype 1.0.0`** — the project name and the app version.
- **`Sam Rivera`** — the reviewer's name, or **Anonymous** if they didn't enter one.
- The next line is the comment itself.
- The last line is the anchor (where they clicked, as % of the page) followed by
  the page URL in `<...>` so Discord doesn't expand a big link preview.

## Troubleshooting

**Comments post to the wrong channel.**
A webhook is bound to the channel it was created for. Edit the webhook
(Server Settings → Integrations → Webhooks → click the webhook → **Channel**)
and pick the right one, or make a new webhook and update the widget's URL.

**Nothing arrives / submit shows "Couldn't send".**
The webhook was probably deleted or the URL is mistyped. A deleted webhook
returns `404 Unknown Webhook`. Recreate it (Step 1) and paste the fresh URL.
Also confirm `transport` is set to `"discord"` — with the default `"json"`
transport the widget sends the raw payload, which Discord rejects.

**Messages stop appearing under heavy use (rate limits).**
Discord rate-limits webhooks (roughly ~30 messages per minute per webhook; it
returns HTTP `429` when exceeded). For normal prototype review this is never a
problem. If you're stress-testing, space submissions out or use a separate
webhook per prototype. The widget already retries once automatically after a
short backoff.

**Message shows "Anonymous".**
That just means the reviewer left the name field blank. To hide the name field
entirely, init with `fields: { name: false }`.

---

Want structured, queryable storage instead of chat messages? See the
[Cloudflare destination](../cloudflare/README.md).
