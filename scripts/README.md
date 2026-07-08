# Demo film builder

`record-demo.mjs` films the full tyrekick lifecycle as real browser video and
encodes it to a GIF. It's a **repeatable build step**, not a one-off recording —
every release can re-shoot the demo with one command, always against the real
widget and a real worker.

```
scripts/
  record-demo.mjs      the recorder (director + encoder)
  film/
    console.html       the coding-agent console surface (Acts 0 & 2)
    chat.html          the phone/chat surface (the ask-lands match cut)
docs/
  demo.gif             the cut embedded in the top-level README (committed)
  demo-hero.gif        output: hero cut  (~43s)   — local only; copy to demo.gif to ship
  demo-video.gif       output: full story (~100s) — local only; for pitches / hosting
```

`demo-hero.gif` and `demo-video.gif` are gitignored — they're regenerable
build outputs. Only `demo.gif` (the README hero) is committed.

## What it does

Spins up a throwaway local set — `python3 -m http.server` for the repo demo and
`wrangler dev` for the tyrekick worker — then drives a headless Chromium with
Playwright while recording video. An injected cursor glides and clicks, the
comment is typed live, and in Act 2 the on-screen `resolve_feedback` call is an
**actual PATCH to the local worker**, so the reviewer's pin genuinely turns
green on camera. When filming ends the set is torn down; nothing touches the
cloud worker or leaves state behind.

The story runs: a problem statement → a cast intro → the build with review
wired in → the ask lands → the review → the agent triages (fixing one comment,
challenging another) → the pins go green and grey. A persona chip shows who's
active at each moment. The beat-by-beat lives in the script itself
(`record-demo.mjs`), which reads top-to-bottom like a screenplay.

## Prerequisites

- Node ≥ 18 and repo deps installed (`npm install`) — Playwright's Chromium
  (`npx playwright install chromium` if it's missing)
- `ffmpeg` on your PATH (`brew install ffmpeg`)
- `python3` (macOS ships it)
- The local worker token in `destinations/cloudflare/.dev.vars`
  (`TYREKICK_TOKEN=local-test-token`) — already present in this repo

No Cloudflare login and no network are needed; `wrangler dev --local` runs the
worker in-process.

## Running it

```bash
node scripts/record-demo.mjs           # both outputs (default)
node scripts/record-demo.mjs --full    # only docs/demo-video.gif (~72s)
node scripts/record-demo.mjs --hero    # only docs/demo-hero.gif  (~35s)
node scripts/record-demo.mjs --both    # explicit both
```

A full render is ~1–2 min (film in real time + a fast ffmpeg pass). The set
ports are 8091 (page) and 8092 (worker) — make sure they're free.

## Tweaking the film

All timing and copy are plain constants in `record-demo.mjs`; the shot list
maps each one to its beat. The knobs you'll reach for most:

| Want to change | Edit |
| --- | --- |
| Overall pace | `PACE` (per cut), or the `say()` defaults `beat` / `lead` |
| A specific pause | the `hold(NNNN)` on that beat |
| Caption wording | the string in that `say(page, "…")` call |
| Reading speed | `22` (ms/char) in the caption typewriter inside `FILM_RIG` |
| Cursor travel | the last arg of each `glide(page, x, y, ms)` |
| Comment typing speed | `page.keyboard.type(COMMENT, { delay: 24 })` |
| Cast names / colours / roles | the `CAST` object |
| What's in hero vs full | the `if (!hero)` gates and the hero deltas in the shot list |
| Output size / smoothness | `fps=12` and `scale=900` in the ffmpeg command (`recordOnce`) |

Iterate from a full render — the between-scene feel is what you're tuning, and a
take costs under a minute.

## The surfaces

`film/console.html` and `film/chat.html` are film-only assets (they ship in the
npm tarball harmlessly but aren't part of the widget). The console exposes a
tiny JS API the recorder drives — `agentReset()`, `agentPrompt()`,
`agentLine(cls, text)`, `agentBlock(html)` — each typing out and resolving when
done. The caption bar, persona chip, and cursor are injected at runtime by
`FILM_RIG` so they work on any page (demo, console, or chat).

## Choosing what ships

`docs/demo.gif` is what the README embeds — currently the hero cut. Point it at
whichever cut you prefer (`demo-hero.gif` for a tight README hero, or
`demo-video.gif` for the full story); both are re-rendered by the recorder.

```bash
cp docs/demo-hero.gif docs/demo.gif    # e.g. ship the hero cut
```
