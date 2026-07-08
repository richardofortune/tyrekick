# Tyrekick — where I'm at

**TL;DR**
You can build a prototype with AI in minutes now, but getting people to actually
look at it and telling the AI what they said is still a pain — screenshots in
chat, comments you lose, stuff you retype by hand. Tyrekick fixes that. People
click on the live page and leave a comment (no login), it goes somewhere I own,
and my AI agent reads it, fixes what matters, and marks it done — and their
comment turns green so they know it happened. Best part: the agent can add the
whole thing to a build in one step, and leave it out of the real production
version just as easily. It works, I've used it for real, it's free and open, and
nothing gets sent to me or anyone else.

## What I built, and why I bothered with each bit

- **It slots straight into the build.** The agent's already doing the building,
  so adding the review layer is just one more step it takes — one line of code —
  and taking it back out for the production version is just as easy. So it's not
  something you bolt on and have to maintain: it's on for the review copy, off
  for prod.
- **Comment straight on the page.** Anyone with the link can click a spot and
  type. No account, takes ten seconds. I did this because the thing I'm
  competing with is "send a screenshot in the group chat" — so if it's any
  harder than that, nobody uses it.
- **It quietly grabs the useful details.** Each comment records what you clicked
  and its text, which page, which version, your device, and any errors on the
  page. Without that, "this button's weird" is useless — the agent needs to know
  which button, on which build, or it just guesses.
- **The feedback goes to a place I own** (a Discord channel, or a small server).
  The whole point is there's no middleman — it goes from the person's browser
  straight to me.
- **The agent reads it back, and one line sets it all up.** I can say "make this
  reviewable, get Dave to look" and it does the setup. The magic I care about is
  how *easy* it is to pull a person into the loop — if setup's a faff, it
  doesn't happen.
- **The comment turns green when it's fixed,** with a note on what changed. This
  matters more than it sounds — if people don't see anything happen, they don't
  bother commenting again.
- **The agent can push back.** If a suggestion's bad, it says no with a reason
  instead of just doing it. Feedback is opinions, not orders, and blindly doing
  everything makes the thing worse.
- **Feedback is tied to a version.** The next build sees the last round's
  comments; old ones drop off unless someone raises them again. I don't want a
  pile of stale feedback hanging over every future build.

## What it makes easy

- Get the review loop into your build in one step — and out of prod just as easily.
- Turn a prototype into something people can review, in one sentence.
- Let a non-technical mate give proper feedback in ten seconds, on their phone, no account.
- Get that feedback in a shape the AI can just act on — no retyping.
- Have the agent fix it and show the person it got done.
- Keep all of it on my own stuff, with nothing tracking anyone.

## What it doesn't do (being straight)

- No screenshots or recordings.
- People see their own comments, not each other's.
- The full agent loop needs the small server (Discord on its own is just the
  quick notifications version).
- It's for a few trusted people, not a public launch.

## Next steps

1. Put the finished demo video on the public repo.
2. List it where AI agents find their tools, so "make this reviewable" actually
   points at something.
3. Publish the write-up and ask a few builder groups how they share prototypes
   now — to find the first real users.
4. Keep using it on my own stuff; every real use turns up something.
5. Not doing yet, on purpose: reviewing multiple design options at once, and a
   paid "I'll run the server for you" version.
