# The Outer Loop

*Draft — for publication (agentexperience.ax pitch / personal blog / HN).
Author: Richard Fortune. Status: v1, 2026-07-06.*

---

On July 3rd I clicked a button on a prototype my coding agent had built,
typed "Typo", and hit send. The comment failed to deliver — the endpoint it
was aimed at didn't exist yet. I closed the tab and forgot about it.

On July 5th, that comment was fixed by an agent.

In between, the comment sat in localStorage as unsent work. When I reopened
the page two days later, it quietly retried itself — into a feedback store
that hadn't existed when I wrote it. An agent listed it over MCP, noticed it
was pinned to the same date fields as a newer comment, inferred they were the
same complaint, shipped a fix, deployed it, and marked the comment resolved
with a note. When I reloaded the page, the pin I'd left turned green, and
hovering it showed me what had changed and where.

Nobody retyped anything. Nobody opened a ticket. The feedback outlived the
build it criticized, survived the death of its own transport, and arrived as
a work item in the hands of the thing that could fix it.

I'm telling this story because the machinery that made it possible is
trivially small — a 13 KB script, a webhook, and one protocol — and because
the absence of that machinery is, I think, the least-discussed bottleneck in
agentic software development.

## The inner loop is solved. The outer loop is a group chat.

Agentic development has an inner loop, and it's excellent: the agent writes
code, runs tests, lints, screenshots its own work, and iterates — dozens of
times an hour, no human required. The industry has also built the second
checkpoint well: diff review. Pull-request review by humans and increasingly
by other agents is standard infrastructure.

But there is a third checkpoint, after the deploy, and nobody owns it:
**does the built thing actually work for the humans it was built for?**

Call it experience review. It can't be automated away, because it's the one
place where the question isn't "is this correct?" but "is this right?" — and
"right" lives in the heads of people who will never read your diff. The
prompt that generated the app encoded the builder's mental model; the gap
between that model and the users' model is precisely what no self-verifying
loop can see. Microsoft's design research on vibe coding says the quiet part:
the promise of prototyping-at-conversation-speed is getting software *in
front of people* faster. And then what?

Then, today: you paste a link into a group chat with "thoughts?". Feedback
comes back as screenshots with circles drawn on them, voice notes, a text
that says "the button feels weird" (which button? which version?). You
mentally collate it — or, more often, lose it. What survives, you retype into
your agent's context window, badly. The agent fixes something, redeploys to a
new preview URL, and nobody tells the reviewers what happened to their
comments, so they don't comment next time.

Look at the shape of that. Building collapsed from weeks to minutes.
Self-verification collapsed. Deployment collapsed. And wedged between those
collapsed stages sits an unpaid clerical pipeline — summon, capture, collate,
relay, close — running at the speed of chat scroll and human memory. Amdahl's
law is not sentimental: **the loop now runs exactly as fast as its slowest
unstructured segment**, and that segment is a human being used as a
clipboard.

## What the outer loop actually requires

The obvious response is "so build an issue tracker for prototypes," and it's
wrong. Trackers are the tooling of scarce implementation: when acting on
feedback costs weeks, you need queues, priorities, sprints — machinery for
rationing labor. When acting on feedback costs minutes, the queue is not just
unnecessary, it's the wrong shape. Three different scarcities govern now.

**Human attention is scarce, so the summons must cost one sentence.** The
biggest killer of experience review isn't bad tooling — it's that the moment
of "someone should look at this" usually dies unexpressed, because acting on
it means a context switch: deploy, write instructions, chase replies. In the
loop above, instrumenting the prototype was literally one sentence to the
agent ("make this reviewable"), and the agent deployed the feedback
infrastructure itself — including the part my persona famously can't do
(standing up a worker). Agents are not just the consumers of the outer loop;
they are how it gets installed.

**Reviewer identity is friction, so the loop must run on capabilities, not
accounts.** Every review tool that requires the *reviewer* to log in has
misunderstood whose time is being spent. The reviewer is doing you a favor
on their phone. In the loop above, review requires no account anywhere: a
comment's identity is an unguessable UUID that acts as a capability — the
browser that submitted it can later ask "what happened to this?" and nothing
else can ask anything. Identity turns out to be needed for aggregation
(projects, teams, longitudinal insight), not for the loop itself.

**Coherence is scarce, so feedback must reach the builder as data, not
prose.** "The button feels weird" is testimony. What an agent needs is the
element (tag, id, visible text — greppable straight into source), the section
heading, the route, the build SHA, the viewport, and the uncaught exceptions
that were sitting on the page when the human said "it doesn't work." That
last one matters more than it sounds: reviewers describe symptoms; the
payload can carry the disease. A comment with structure attached is a better
bug report than most humans write on purpose — and it was written by
accident.

And one more, which I underestimated until I watched it happen: **the loop
must close visibly.** Reviewers are a depleting resource. A friend reviews
your prototype once; whether they ever do it again depends on whether
anything visibly happened. The green pin — your comment, resolved, with a
note saying what changed, sitting exactly where you left it — is not a
feature. It's the mechanism that makes the second review happen. Feedback
systems die of silence, not of friction.

## Human review as a tool call

The human-in-the-loop literature has converged on synchronous interrupts:
the agent pauses at a checkpoint, a human approves or rejects, execution
resumes. That's the right shape for irreversible actions. It is the wrong
shape for experience review, which is slow, plural, and opinionated — you
cannot block an agent on five people finding time to have feelings about a
checkout flow.

The outer loop is the asynchronous complement: **the agent finishes a
feature and *calls for human review* the way it would call a linter** —
deploy, instrument, notify, keep working — and the humans' structured
verdicts arrive later as actionable input, over the same protocol surface
(MCP, in my implementation) the agent uses for everything else. Human
judgment becomes a callable, awaitable resource with a defined response
schema.

Once you see it that way, the endgame stops being "humans approving agent
work" and becomes something more interesting: an **editing relationship**.
Because implementation is nearly free, the agent doesn't need permission to
*try* — it needs permission to *keep*. Feedback arrives; the agent implements
it speculatively on a preview; the human's entire role compresses into the
one judgment humans are actually best at: *this one or that one?* Keep or
kill. The approval object stops being a ticket describing a hypothetical
change and becomes a comparison between two running pieces of software.
No incumbent feedback pipeline is shaped for this, because every incumbent
was built when implementation was the expensive part worth managing.

## The metric nobody is tracking

Here's a number I'd love every agentic team to know about themselves: the
**first-run acceptance gap** — how often an agent's "done" needs human
nudging afterward, and about *what*. Not test failures; those are the inner
loop's business. The nudges that arrive only after other humans saw the
thing: unclear copy, wrong emphasis, missing affordance, "works on your
machine's locale" (my date fields — both of my own first pins were about
date formatting, which no test would ever have caught).

That gap is the outer loop's reason to exist, and it's currently invisible
because the feedback that would measure it evaporates in group chats. Collect
it structurally and you get something better than a metric: a corpus. What
do humans always flag in your builds? Which routes draw pins? What does
nobody ever mention? Even for disposable prototypes — *especially* for
disposable prototypes, where the software dies but the builder persists —
the feedback→fix→resolve exchange is a record of where machine confidence
and human judgment disagree. That record compounds. The prototypes were
never the asset.

## Protocols, not platforms

The app-builder platforms are closing their own loops — Lovable, v0, Replit
will each have native review inside their walls, and Vercel already has
account-gated preview comments. Good. But a loop that only works inside one
platform's walls is a retention feature, not infrastructure. The outer loop
wants what the inner loop got: a neutral, protocol-native standard that
works wherever the software happens to be — a static host, a tunnel, a
Cloudflare page, somebody's VPS.

That's why the reference implementation I built ([Tyrekick][repo], MIT, no
backend, nothing phones home) treats MCP as the load-bearing wall: feedback
goes from the reviewer's browser to a destination the builder owns, and any
agent that speaks the protocol can pull it, act on it, and resolve it. The
tool is small on purpose. The claim is not "use my widget." The claim is:

**Agentic development will not feel finished until "get humans to look at
this and tell me what they think" is a one-sentence operation with a
structured, machine-readable reply — and closing that loop is mostly a
protocol problem, not a product problem.**

The inner loop taught agents to verify themselves. The outer loop is how
they learn what we actually meant.

[repo]: https://github.com/richardofortune/tyrekick

---

*The demo GIF in the [repo README][repo] is unstaged footage of the loop
described here, running against a live worker.*
