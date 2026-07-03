# Tyrekick — end-to-end demo script

The story in one line: **a reviewer pins a comment on a live prototype, and a coding
agent fixes it — nobody retypes anything.** Five beats, ~4 minutes.

## Before the audience arrives

```bash
# 1. Serve the demo app
python3 -m http.server 8080          # repo root

# 2. Run the feedback worker (local, in-memory-ish KV)
cd destinations/cloudflare && ../../node_modules/.bin/wrangler dev --port 8787 --local
#    token lives in destinations/cloudflare/.dev.vars (TYREKICK_TOKEN=local-test-token)

# 3. Register the MCP pipeline for Claude Code (once)
claude mcp add tyrekick \
  --env TYREKICK_URL=http://localhost:8787 \
  --env TYREKICK_TOKEN=local-test-token \
  -- node <repo>/mcp/dist/server.js

# 4. Optional: clear old records for a clean run
#    (wipe .wrangler/state in destinations/cloudflare and restart wrangler)
```

Two windows side by side: **browser** (left) and **Claude Code** (right).

---

## Beat 1 — The prototype (30s)

Open `http://localhost:8080/demo/index.html?webhook=http://localhost:8787/feedback`.

> "This is a prototype — the kind of thing an agent builds you in an afternoon.
> It's reached the moment every AI-built project reaches: **someone else needs to
> look at it.** Normally that means screenshots in a group chat and feedback that
> dies there."

## Beat 2 — The pin (45s)

Click the speech-bubble button → click the **Search trips** button → type
*"this button does nothing when I click it"* → Send.

> "No account, no training — click the thing, say the thing. But watch what got
> captured that a screenshot never has: the element's **visible text**, the
> **section heading** it sits under, the exact position, the viewport, the app
> version — and if the page had thrown an error, that too."

(Pin one more on any text: *"can this be friendlier?"* — shows pins accumulate.
Open the drawer via the list button to show comments are reviewable in place.)

## Beat 3 — The pull (45s)

In Claude Code, paste exactly this:

> **"List the open feedback. Narrate as you go: which tool you call, what the
> payload tells you, and how you locate each issue in the source."**

The narration instruction is the demo trick — the agent explains the loop *while
performing it*. Audience sees `list_feedback` return:

```
element: <button> "Search trips"
under: "Plan your escape"
> this button does nothing when I click it
```

> "That's a better bug report than most humans file — and no human filed it."

## Beat 3½ — Optional: the triage beat (30s, shared-review flavour)

If you're demoing the "sharing with others" story, add one line before the fix:

> **"That feedback is from external reviewers — walk me through it."**

The agent lists the open items and waits; you say *"approve 1, decline 2 —
that's intentional"*; it records the decisions (`triage_feedback`) and only
actions the approved ones.

> "The agent never reshapes the app around untriaged opinions — the human
> stays the editor-in-chief. If it's your own punch list, you skip this beat
> entirely."

## Beat 4 — The fix (60s)

> **"Fix what was flagged in demo/index.html, then resolve each item with a note
> saying what you changed."**

The agent greps for the visible text ("Search trips"), lands on the exact line,
makes the change, calls `resolve_feedback`. Point at the resolution notes:

> "The agent closes its own loop — every item gets a note saying what changed.
> If a comment was ambiguous, it resolves with 'INTERPRETED — please confirm'."

## Beat 5 — The close (30s)

Reload the browser. The button works. Then in Claude Code: **"any open feedback
left?"** → `0`.

> "Reviewer pinned it. Agent fixed it. The feedback was never copied, pasted,
> or retyped. That's the outer loop agentic development is missing — and it's a
> ~8 KB script plus a webhook you own. No Tyrekick servers touched your data at
> any point."

---

## Variations

- **Discord flavour:** point `?webhook=` at a Discord webhook URL +
  `&transport=discord` to show the human-readable tier (comments ping a channel
  live — great on a phone held up to the audience). Note honestly: Discord is
  write-only; the agent loop needs the worker destination.
- **Phone reviewer:** open the demo from a phone on the same network
  (`http://<mac-ip>:8080/...`) — tap-to-pin works; makes the "your mum can review
  this" point.
- **Stats kicker:** end with *"give me feedback stats"* → counts by route/status —
  gestures at the longitudinal story (which routes generate confusion, does
  feedback decay version over version).

## Failure modes to pre-empt

- Wrangler not running → widget shows "Couldn't send. Copy your comment?" (which
  is itself a decent resilience demo, but not the one you planned).
- Local KV persists across wrangler restarts (`.wrangler/state`) — clear it for a
  clean open-count.
- The MCP registration is per-project scope by default — run the `claude mcp add`
  from the directory you'll demo in, or use `--scope user`.
