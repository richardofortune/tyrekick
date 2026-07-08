# Quickstart — from idea to feedback loop

Most of the time it starts the same way: you have an **idea**, you build it with
a coding agent over a few prompts, and at some point you want a few people you
trust to look at it before you go further.

The trick is to decide that *early*. If you know from the start you'll want eyes
on it, review becomes part of the build — not a scramble bolted on at the end.

Here's the whole arc, and where Tyrekick fits:

```text
  idea  →  build it with your agent  →  get it reviewed  →  act on feedback  →  next version
                                        └──────────── Tyrekick ────────────┘
```

Three stops below; each one is a fine place to stop.

---

## The one-sentence path (if you use a coding agent)

This is the whole point of Tyrekick, and you can say it at any point in the arc
above — right at the start of building, or the moment you decide it's ready for
eyes. If you're in Claude Code or a similar agent:

1. Add the skill once — copy `make-reviewable` into `~/.claude/skills/`
   (it ships with the package, or grab it from the repo).
2. Tell your agent, either up front or whenever you're ready:

   > **"build me X — and make it reviewable so I can get feedback"**
   >
   > …or, later: **"make this reviewable, and draft a note asking a couple of
   > people to look."**

The agent works out where you're hosted, sets up the right destination
(deploying a small server for you if you're on a public URL), adds the widget to
the review copy, connects the read-back, and hands you a share link plus a
message to send. You don't touch a webhook or a config file — and taking it back
out for the production version is one more instruction.

That's it — you're set up. Everything below is what the skill does by hand, if
you'd rather do it yourself.

---

## Where does the feedback go? (it's always somewhere you own)

There's no Tyrekick server in the middle — feedback goes from the reviewer's
browser straight to a destination **you** control. You pick one:

| Destination | Who runs it | Good for | Agent can read it back? |
| --- | --- | --- | --- |
| **Discord webhook** | you (a channel) | seeing feedback instantly, private links | no (send-only) |
| **Cloudflare Worker** | **you** (free tier, on *your* Cloudflare account) | the full loop; anything public | **yes** |
| **Same-origin function** | you (your existing host) | prototypes already on Netlify / Cloudflare Pages / Vercel — drop an endpoint at `/api/feedback`, no separate hosting | yes |
| **Any JSON endpoint** | you | wiring into a backend you already have | yes, if it exposes the read API |

When the `make-reviewable` skill "sets up a server for you," that's the
**Cloudflare Worker template** — and it deploys it to *your* Cloudflare account,
not ours. It's a small file that stores each comment as structured data you own;
the agent reads it back from there. Everything stays on your infrastructure.

> There is deliberately **no "hosted by us" option** today — the point of
> Tyrekick is that your reviewers' feedback never routes through anyone else.
> (A managed "we'll run it for you" tier may come later, for people who can't
> stand up their own — but the self-owned path will always exist.)

**One requirement:** the page has to load from an **http(s) URL** — a bare HTML
file opened via `file://` (or emailed around) can't send feedback or receive
receipts. If your app isn't hosted yet, the one-sentence path handles it (it
deploys or tunnels the page for you); doing it by hand, see
[hosting a bare file](troubleshooting.md#my-app-is-a-file-not-a-hosted-page--nothing-sends).

---

## Stop 1 — See it working in 60 seconds (Discord)

The fastest way to watch feedback arrive. Good for a prototype on your own
machine or a private link. It's send-only — reviewers can comment, but the
agent can't read it back yet (that's Stop 2).

1. In Discord: **Server Settings → Integrations → Webhooks → New Webhook →
   Copy Webhook URL.**
2. In your project folder:

   ```bash
   npx tyrekick init --webhook <your-webhook-url>
   ```

   (Or paste the `<script>` tag from the [README](../README.md) before
   `</body>` yourself.)
3. Open your page. A round button appears in the corner. Click it → click
   anywhere on the page → type a comment → **Send**.
4. The comment lands in your Discord channel.

**You're now collecting feedback.** No accounts, no backend.

---

## Stop 2 — The full loop (your own server + your agent)

This is where the agent reads feedback back, fixes what's flagged, and marks it
done — and the reviewer's pin turns green. You need this for anything on a
public URL, and for the agent loop.

The server is a small Cloudflare Worker template that ships with Tyrekick. It's
yours, runs on the free tier, and stores every comment as structured data you
control.

1. **Deploy the server** (one-time):

   ```bash
   cd destinations/cloudflare
   npx wrangler kv namespace create FEEDBACK   # paste the printed id into wrangler.toml
   npx wrangler deploy                         # prints your worker URL
   npx wrangler secret put TYREKICK_TOKEN      # paste a long random string
   ```

   Optional: `npx wrangler secret put DISCORD_WEBHOOK` to also mirror every
   comment (and every fix) to a Discord channel.

2. **Point the widget at it:**

   ```bash
   npx tyrekick init --webhook https://your-worker.workers.dev/feedback
   ```

3. **Connect your agent** (one-time):

   ```bash
   claude mcp add tyrekick \
     --env TYREKICK_URL=https://your-worker.workers.dev \
     --env TYREKICK_TOKEN=<your token> \
     -- npx tyrekick-mcp
   ```

---

## Using it, day to day

1. **Share the link** with a few people you trust. They click, comment, and
   they're done — no login, works on a phone, takes about ten seconds.
2. **When you're ready to act,** tell your agent:

   > "List the open feedback and fix what people flagged."

   It reads each comment — with the exact element, the page, the version, and
   any errors that were on the page — fixes what's worth fixing, pushes back on
   what isn't (with a reason), and marks each one resolved with a note.
3. **The reviewer reloads and their pin has turned green,** showing what
   changed. The loop is closed — nobody retyped anything.

---

## Good to know

- **Discord is the taster; the worker is the loop.** Discord shows feedback
  arriving; the worker is what lets the agent read it back and close the loop.
- **Reviewers never install or log in.** You own the destination — feedback
  goes from their browser straight to you, and nothing phones home.
- **It's for the review copy, not production.** Add it to the build you're
  getting eyes on; leave it out of the version real users see. With a coding
  agent that's one instruction each way.
- **Feedback is scoped to a version.** Your next build sees the last round's
  comments and what happened to them; older feedback drops off unless someone
  raises it again — so you never carry a stale backlog.

More detail: [configuration](configuration.md) · [destinations](destinations.md)
· [the agent loop](agent-loop.md) · [what reviewers see](reviewing.md).
