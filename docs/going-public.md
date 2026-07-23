# Taking a prototype public

You've built something and you want to share it widely — a LinkedIn post, a
public link, a Show HN. That's a different situation from sending a private
link to five people you trust, and Tyrekick has three capabilities for it.
This is the order to set them up in.

> **The one rule for a public URL:** leave **shared review OFF**. Everything
> else here makes a public share safer or nicer; shared review is the one knob
> that makes it *worse* on a public URL, because it publishes every reviewer's
> comments (and names) to every visitor. Details in
> [shared review](shared-review.md) — but for a public post, don't turn it on.

## The sequence

1. **Use the Cloudflare Worker destination**, not Discord. The worker is what
   makes receipts, the reviewer's own pin history, rate limiting, and AI
   auto-reply possible — Discord is write-only. If you're not on the worker
   yet, see [destinations](destinations.md#cloudflare-worker-the-actual-loop).

2. **Add rate limiting** so one abusive visitor can't run up your bill.
   → [Rate limiting guide](rate-limiting.md). Two lines of config plus a
   redeploy. Do this before you post the link anywhere public.

3. **Decide on shared review — and for a public URL, decline it.** The full
   trade is in the [shared review guide](shared-review.md). On a private link
   it's great; on a public one it publishes everyone's feedback to everyone.
   Leaving it off (the default) means each reviewer sees only their own pins,
   which is what you want publicly.

4. **Optionally, turn on AI auto-reply** for the "someone's listening" feel —
   a one-sentence acknowledgement in each reviewer's own thread.
   → [AI auto-reply guide](ai-auto-reply.md). It's off by default, bounded in
   cost, and — because you kept shared review off — each reply is seen only by
   the person who wrote the comment.

5. **If you enabled AI auto-reply, set an Anthropic spend limit** in the
   Anthropic console. The in-app daily cap is a soft app-level guard; the
   workspace spend limit is the hard account-level ceiling. Belt and braces.

6. **Set a stable `projectName`.** Pick an explicit, kebab-case
   `data-project-name` and keep it identical across redeploys. It's the durable
   identity of your feedback stream; the `document.title` fallback silently
   forks the stream the first time you edit the page title.

7. **Share the link, then watch — don't auto-act.** On a public share, the safe
   posture is [passive monitoring](agent-loop.md): read the feedback (Discord
   mirror for real-time, MCP `list_feedback`/`feedback_stats` for a digest),
   decide what's worth acting on yourself. Don't point an autonomous fixing
   agent at anonymous public input.

## The five-minute version

```bash
WORKER=https://your-worker.workers.dev     # your deployed worker

# 2. rate limiting is already in the template wrangler.toml — just deploy
npx wrangler deploy                        # add -c wrangler.local.toml if you use one

# 4. (optional) AI auto-reply
npx wrangler secret put ANTHROPIC_API_KEY  # paste an Anthropic key
npx wrangler deploy
# 5. then set a workspace spend limit at console.anthropic.com

# 3. shared review: do NOT set TYREKICK_REVIEW_KEY on a public URL
```

That's it. Rate limiting on, shared review off, AI reply optional, spend limit
set, `projectName` stable. Post the link.

## What each capability protects or provides

| Capability | What it's for | Public-URL default |
| --- | --- | --- |
| [Rate limiting](rate-limiting.md) | Caps what one IP can cost you (KV writes, invocations, spam) | **On** — always add it |
| [Shared review](shared-review.md) | Reviewers see each other's pins | **Off** — publishes all comments; wrong for public |
| [AI auto-reply](ai-auto-reply.md) | A friendly one-line acknowledgement per comment | Optional — safe on, off by default |
