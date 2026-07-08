#!/usr/bin/env node
/**
 * record-demo.mjs — films the full tyrekick lifecycle as real video → GIF.
 *
 * Four acts, matching who-does-what-when in the real world:
 *   Act 0  the builder + their agent — one sentence ("make this reviewable")
 *          deploys the loop and drafts the ask                        [studio]
 *   cut    the ask lands in a trusted person's chat                    [phone]
 *   Act 1  the reviewer pins one structured comment, leaves          [browser]
 *   —later—
 *   Act 2  the builder's agent reads it over MCP, fixes, resolves     [studio]
 *   Act 3  the reviewer returns — the pin has turned green           [browser]
 *
 * Everything is real: local demo page (python), local tyrekick worker
 * (wrangler dev), a live Playwright browser with an injected cursor, and the
 * Act-2 resolve is an actual PATCH to the worker, synced to the on-screen call.
 *
 *   node scripts/record-demo.mjs            # full story  → docs/demo-video.gif
 *   node scripts/record-demo.mjs --hero     # tight cut   → docs/demo-hero.gif
 *   node scripts/record-demo.mjs --both     # both (default)
 *
 * Requires: node >= 18, ffmpeg, repo deps. Worker token: .dev.vars.
 * docs/demo.gif (the README hero) is a copy of demo-hero.gif.
 */
import { chromium } from "@playwright/test";
import { spawn, execSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE_PORT = 8091;
const WORKER_PORT = 8092;
const TOKEN = "local-test-token"; // destinations/cloudflare/.dev.vars
const VIDEO_DIR = resolve(ROOT, ".demo-video");

// The good comment (actioned) and a spurious one the agent challenges.
const COMMENT = "What does 'Surprise me' do? Nothing happens when I click it.";
const NOTE = "Surprise me now picks a destination for you — try it.";
const COMMENT_BAD = "Make the trip prices flash and blink so they grab attention.";
const NOTE_DECLINE = "Blinking text fails accessibility (WCAG 2.2.2) — declining. I can make the price bolder instead.";

let PACE = 1; // 1 = full, <1 = hero (compresses every hold + narration pause)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hold = (ms) => sleep(Math.round(ms * PACE));

/* ---- rig injected after every navigation (caption bar + film cursor) ---- */

const FILM_RIG = `(() => {
  const hide = [...document.querySelectorAll('body *')].find(el =>
    el.children.length <= 3 && /feedback below goes to the destination/i.test(el.textContent||'') &&
    el.getBoundingClientRect().top < 60);
  if (hide) hide.style.display = 'none';

  if (!document.getElementById('film-cap')) {
    const c = document.createElement('div');
    c.id = 'film-cap';
    c.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:2147483646;background:#16181D;color:#F2F3F5;font:500 18px/1.35 -apple-system,BlinkMacSystemFont,sans-serif;padding:12px 22px;letter-spacing:-.01em;box-shadow:0 -1px 8px rgba(0,0,0,.3);min-height:30px;display:flex;align-items:center;gap:13px';
    c.innerHTML =
      '<span id="film-chip" style="display:none;align-items:center;gap:8px;flex:none;transition:opacity .3s">' +
      '<span id="film-av" style="width:26px;height:26px;display:flex;align-items:center;justify-content:center;font:600 12px ui-monospace,Menlo,monospace"></span>' +
      '<span id="film-name" style="font-size:14px;color:#c9cdd4;white-space:nowrap"></span>' +
      '<span style="color:#3a3e46">|</span></span>' +
      '<span id="film-text" style="flex:1"></span>';
    document.body.appendChild(c);
  }
  // Persona chip: humans get a round avatar, the agent a square terminal chip.
  window.__actor = (kind, name, bg, ink) => {
    const chip = document.getElementById('film-chip');
    const av = document.getElementById('film-av');
    chip.style.display = 'flex';
    av.style.background = bg; av.style.color = ink;
    av.style.borderRadius = kind === 'agent' ? '5px' : '50%';
    av.textContent = kind === 'agent' ? '▸' : name[0];
    document.getElementById('film-name').textContent = name;
    chip.style.opacity = '0';
    requestAnimationFrame(() => { chip.style.opacity = '1'; });
  };
  window.__cap = (t) => new Promise((done) => {
    const el = document.getElementById('film-text'); let i = 0;
    (function tick(){ i++; el.textContent = t.slice(0,i) + (i<t.length?'▍':'');
      if (i<t.length) setTimeout(tick, 22); else done(); })();
  });

  if (!document.getElementById('film-cursor')) {
    const cur = document.createElement('div');
    cur.id = 'film-cursor';
    cur.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-2px,-2px)';
    cur.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M5 3l14 9-6.5 1L9 19z" fill="#16181D" stroke="#fff" stroke-width="1.4"/></svg>';
    document.body.appendChild(cur);
    document.addEventListener('mousemove', (e) => {
      cur.style.left = e.clientX+'px'; cur.style.top = e.clientY+'px'; }, true);
    document.addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;border:2.5px solid #FFC53D;border-radius:50%;width:10px;height:10px;left:'+(e.clientX-5)+'px;top:'+(e.clientY-5)+'px;opacity:.95;transition:all .45s ease-out';
      document.body.appendChild(r);
      requestAnimationFrame(() => { r.style.width='46px'; r.style.height='46px';
        r.style.left=(e.clientX-23)+'px'; r.style.top=(e.clientY-23)+'px'; r.style.opacity='0'; });
      setTimeout(() => r.remove(), 500);
    }, true);
  }
})();`;

// Lift the widget's corner controls above the caption bar (demo page only).
const WIDGET_OFFSETS = `(() => {
  const r = document.querySelector('[data-tyrekick]');
  if (!r || !r.shadowRoot || r.shadowRoot.querySelector('#film-offsets')) return;
  const s = document.createElement('style'); s.id = 'film-offsets';
  s.textContent = '.trigger.pos-bottom-right{bottom:78px!important}.list-toggle.pos-bottom-right{bottom:138px!important}';
  r.shadowRoot.appendChild(s);
})();`;

/* ------------------------------ the cast --------------------------------- */

const CAST = {
  builder:  { kind: "human", name: "Richard", bg: "#7c6cff", ink: "#fff", role: "builds with his coding agent" },
  agent:    { kind: "agent", name: "Agent",   bg: "#FFC53D", ink: "#16181D", role: "installs the loop, fixes what's flagged" },
  reviewer: { kind: "human", name: "Dave",    bg: "#0ea5e9", ink: "#fff", role: "someone Richard trusts" },
};

/* ------------------------------ director kit ----------------------------- */

async function waitHttp(url, tries = 60) {
  for (let i = 0; i < tries; i++) { try { await fetch(url); return; } catch { await sleep(500); } }
  throw new Error("not reachable: " + url);
}
async function glide(page, x, y, ms = 650) {
  await page.mouse.move(x, y, { steps: Math.max(12, Math.round(ms / 16)) });
}
async function tap(page) { await page.mouse.down(); await page.mouse.up(); }

/** Center of a light-DOM element. */
async function box(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s); if (!el) return null;
    const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, sel);
}
/** Scroll a light-DOM element to the viewport centre and let pins re-layout. */
async function scrollInto(page, sel) {
  await page.evaluate((s) => { const e = document.querySelector(s); if (e) e.scrollIntoView({ block: "center", behavior: "instant" }); }, sel);
  await sleep(500);
}
/** Center of an element inside the widget's shadow root. */
async function shadowBox(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector('[data-tyrekick]').shadowRoot.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, sel);
}
/** Set the active persona chip in the narration banner. */
async function actor(page, who) {
  const c = CAST[who];
  await page.evaluate((p) => window.__actor(p.kind, p.name, p.bg, p.ink), c);
}
/** narrate → pause: lead (quiet before), type, beat (hold after). */
async function say(page, text, beat = 800, lead = 600) {
  await hold(lead);
  await page.evaluate((t) => window.__cap(t), text);
  await hold(beat);
}
/** Opening cast card — introduces the three parties. */
async function castCard(page, hero) {
  await page.evaluate((cast) => {
    const wrap = document.createElement('div'); wrap.id = 'film-cast';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0f1115;color:#e6e8ec;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;font-family:-apple-system,BlinkMacSystemFont,sans-serif';
    const h = document.createElement('div');
    h.textContent = 'Three parties, one loop';
    h.style.cssText = 'font-size:15px;letter-spacing:.16em;text-transform:uppercase;color:#8b919c;margin-bottom:10px;opacity:0;transition:opacity .5s';
    wrap.appendChild(h);
    const order = ['builder', 'agent', 'reviewer'];
    order.forEach((k, idx) => {
      const c = cast[k];
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:16px;width:460px;opacity:0;transform:translateY(8px);transition:all .5s';
      row.innerHTML =
        '<span style="width:44px;height:44px;flex:none;display:flex;align-items:center;justify-content:center;font:600 18px ui-monospace,Menlo,monospace;background:' + c.bg + ';color:' + c.ink + ';border-radius:' + (c.kind === 'agent' ? '9px' : '50%') + '">' + (c.kind === 'agent' ? '▸' : c.name[0]) + '</span>' +
        '<span><span style="font-size:19px;font-weight:600">' + c.name + '</span>' +
        '<span style="display:block;font-size:14.5px;color:#8b919c;margin-top:2px">' + c.role + '</span></span>';
      wrap.appendChild(row);
      setTimeout(() => { row.style.opacity = '1'; row.style.transform = 'none'; }, 350 + idx * 480);
    });
    document.body.appendChild(wrap);
    requestAnimationFrame(() => { h.style.opacity = '1'; });
  }, CAST);
  await hold(hero ? 2600 : 4200);
  await page.evaluate(() => { const w = document.getElementById('film-cast'); if (w) { w.style.transition = 'opacity .5s'; w.style.opacity = '0'; setTimeout(() => w.remove(), 500); } });
  await sleep(500);
}
async function goto(page, url, { widget = false } = {}) {
  await page.goto(url);
  await page.evaluate(FILM_RIG);
  if (widget) await page.evaluate(WIDGET_OFFSETS);
  await page.mouse.move(500, 380);
}
/** Full-screen dark "curtain" — used to bracket page navigations so the cut
 *  is dark→dark (no white/bright flash between a light page and a dark one). */
async function curtainUp(page, text, instant) {
  await page.evaluate((o) => {
    let d = document.getElementById('film-curtain');
    if (!d) { d = document.createElement('div'); d.id = 'film-curtain'; document.body.appendChild(d); }
    d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0f1115;color:#c9cdd4;display:flex;align-items:center;justify-content:center;font:500 24px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:.06em;opacity:' + (o.instant ? '1' : '0') + ';transition:opacity .45s';
    d.textContent = o.text || '';
    if (!o.instant) requestAnimationFrame(() => { d.style.opacity = '1'; });
  }, { text, instant: !!instant });
  if (!instant) await sleep(450);
}
async function curtainDown(page) {
  await page.evaluate(() => { const d = document.getElementById('film-curtain'); if (d) { d.style.transition = 'opacity .45s'; d.style.opacity = '0'; setTimeout(() => d.remove(), 450); } });
  await sleep(450);
}
/** Navigate under a dark curtain, carrying an optional title across the cut. */
async function darkCut(page, url, title, ms, { widget = false } = {}) {
  await curtainUp(page, title);
  await hold(ms);
  await page.goto(url);
  await page.evaluate(FILM_RIG);
  if (widget) await page.evaluate(WIDGET_OFFSETS);
  await curtainUp(page, title, true); // re-raise instantly on the freshly-loaded page
  await hold(300);
}
/** Opening problem statement — sets up WHY before the build begins. */
async function problemCard(page, hero) {
  await page.evaluate(() => {
    const wrap = document.createElement('div'); wrap.id = 'film-problem';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0f1115;color:#e6e8ec;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:20px;padding:0 12%;font-family:-apple-system,BlinkMacSystemFont,sans-serif';
    const lines = [
      { t: 'You can build a prototype with AI in an afternoon.', c: '#e6e8ec', s: 25 },
      { t: 'Getting people you trust to look at it is the slow part —', c: '#8b919c', s: 22 },
      { t: 'screenshots in a chat, feedback you lose, notes you retype by hand.', c: '#8b919c', s: 22 },
      { t: 'What if that part were effortless?', c: '#FFC53D', s: 25 },
    ];
    lines.forEach((ln, i) => {
      const el = document.createElement('div');
      el.textContent = ln.t;
      el.style.cssText = 'font-size:' + ln.s + 'px;font-weight:' + (ln.c === '#FFC53D' ? 600 : 500) + ';color:' + ln.c + ';opacity:0;transform:translateY(8px);transition:all .5s;max-width:820px';
      wrap.appendChild(el);
      setTimeout(() => { el.style.opacity = '1'; el.style.transform = 'none'; }, 300 + i * 700);
    });
    document.body.appendChild(wrap);
  });
  await hold(hero ? 3600 : 5200);
  await page.evaluate(() => { const w = document.getElementById('film-problem'); if (w) { w.style.transition = 'opacity .5s'; w.style.opacity = '0'; setTimeout(() => w.remove(), 500); } });
  await sleep(500);
}

/* --------------------------------- film ---------------------------------- */

async function film(page, hero) {
  const demoUrl = `http://localhost:${PAGE_PORT}/demo/index.html?webhook=` +
    encodeURIComponent(`http://localhost:${WORKER_PORT}/feedback`);
  const consoleUrl = `http://localhost:${PAGE_PORT}/scripts/film/console.html`;
  const chatUrl = `http://localhost:${PAGE_PORT}/scripts/film/chat.html`;

  /* ---- Opening — the problem, then the cast ---- */
  await goto(page, consoleUrl); // dark console loads under the cards (init-script painted)
  await problemCard(page, hero);
  await castCard(page, hero);

  /* ---- Act 0 — an idea, built with review wired in from the start ---- */
  await page.evaluate(() => window.agentReset());
  await actor(page, "builder");
  if (!hero) await say(page, "It starts with an idea — and wanting trusted eyes on it early.");
  await page.evaluate(() => window.agentPrompt(
    "build me a trip planner — and make it reviewable so I can get feedback"));
  await hold(400);
  await say(page, "One line wires review into the build.");
  await actor(page, "agent"); // control passes to the agent
  await page.evaluate(() => window.agentLine("tool", "make-reviewable  ▸ running"));
  await page.evaluate(() => window.agentLine("res", "✓ deployed a feedback worker you own"));
  if (!hero) await page.evaluate(() => window.agentLine("res", "✓ added the widget — on the review copy only"));
  await page.evaluate(() => window.agentLine("res", "✓ wired the agent read-back (MCP)"));
  await say(page, "It even drafts the note to send.");
  await page.evaluate(() => window.agentBlock(
    "Hey Dave — the trip planner's up 🎒 mind a quick look before I push further?<br>" +
    "Anything that feels off, just click it and tell me.<br>" +
    '<span class="lnk">👉 wander-demo.pages.dev</span>'));
  await hold(1400);

  /* ---- cut — the ask lands with a trusted person (full only) ---- */
  if (!hero) {
    await goto(page, chatUrl);
    await actor(page, "reviewer");
    await say(page, "Dave gets a message — not a form, no account.");
    await page.evaluate(() => window.showMsg());
    await hold(1100);
    const lnk = await box(page, "#lnk");
    await glide(page, lnk.x, lnk.y, 800);
    await hold(250);
    await tap(page);
    await hold(700);
  }

  /* ---- Act 1 — the reviewer pins ---- */
  await goto(page, demoUrl, { widget: true });
  await actor(page, "reviewer");
  await say(page, hero
    ? "Dave — someone Richard trusts — clicks the thing itself. No account."
    : "He clicks Give feedback — nothing to install.");
  const trigger = await shadowBox(page, '[aria-label="Give feedback"]');
  await glide(page, trigger.x, trigger.y, 800);
  await hold(200); await tap(page);
  await page.evaluate(() => { const h = document.querySelector('[data-tyrekick]').shadowRoot.querySelector('.hint'); if (h) h.style.top = '14px'; });
  await hold(300);

  if (!hero) await say(page, "He clicks the thing itself…");
  const target = await box(page, "#surprise-me");
  await glide(page, target.x, target.y, 900);
  await hold(200); await tap(page);
  await hold(250);

  if (!hero) await say(page, "…the comment pins to it. Just type.");
  const ta = await shadowBox(page, "textarea");
  await glide(page, ta.x, ta.y, 450); await tap(page);
  await page.keyboard.type(COMMENT, { delay: 24 });
  await hold(200);

  if (!hero) await say(page, "Send. Element, route and build ride along.");
  const sendBox = async () => page.evaluate(() => {
    const b = [...document.querySelector('[data-tyrekick]').shadowRoot.querySelectorAll('button')].find((x) => /send/i.test(x.textContent));
    const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  let send = await sendBox();
  await glide(page, send.x, send.y, 500); await tap(page);
  await hold(1500);

  // A second, spurious comment — the one the agent will push back on (full only).
  if (!hero) {
    await say(page, "He leaves a second note too — a hasty one.");
    await scrollInto(page, ".price");
    const price = await box(page, ".price");
    await glide(page, price.x, price.y, 900);
    await hold(200); await tap(page);
    await hold(250);
    const ta2 = await shadowBox(page, "textarea");
    await glide(page, ta2.x, ta2.y, 400); await tap(page);
    await page.keyboard.type(COMMENT_BAD, { delay: 22 });
    await hold(200);
    send = await sendBox();
    await glide(page, send.x, send.y, 500); await tap(page);
    await hold(1400);
  }

  const done = await shadowBox(page, ".hint button");
  if (done) { await glide(page, done.x, done.y, 400); await tap(page); }
  await hold(200);

  /* ---- Act 2 — the agent reads it, actions one, challenges the other ---- */
  const patch = (id, body) => fetch(`http://localhost:${WORKER_PORT}/feedback/${id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const listed = await (await fetch(`http://localhost:${WORKER_PORT}/feedback?status=open&limit=5`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })).json();
  const good = listed.items.find((i) => /surprise me/i.test(i.body)) || listed.items[0];
  const bad = listed.items.find((i) => i.id !== good.id);
  const gEl = good.anchor && good.anchor.element;
  const gLabel = gEl ? `${gEl.tag} "${gEl.text || gEl.label || ""}"` : (good.anchor && good.anchor.selector) || "?";
  const gBody = good.body.length > 50 ? good.body.slice(0, 50) + "…" : good.body;
  const bBody = bad ? (bad.body.length > 50 ? bad.body.slice(0, 50) + "…" : bad.body) : "";
  const count = hero || !bad ? 1 : 2;

  // near-real-time: dark cut from the demo into the agent console, no flash
  await darkCut(page, consoleUrl, "— seconds later —", hero ? 1000 : 1600);
  await page.evaluate(() => window.agentReset());
  await curtainDown(page);
  await page.mouse.move(500, 380);
  await actor(page, "agent");
  await say(page, "The agent's watching the feed — comments arrive in seconds.");
  if (!hero) await say(page, "In self-review mode it can act right away.", 700, 300);
  await page.evaluate(() => window.agentPrompt("triage the open feedback and fix what's worth fixing"));
  await hold(400);
  await page.evaluate(() => window.agentLine("tool", 'list_feedback { status: "open" }'));
  await page.evaluate((c) => window.agentLine("res", "← " + c + (c === 1 ? " comment" : " comments")), count);
  await page.evaluate((s) => window.agentLine("res", "#1  " + s), gLabel);
  await page.evaluate((s) => window.agentLine("res", '    "' + s + '"'), gBody);
  await hold(300);
  await page.evaluate(() => window.agentLine("note", "  editing demo/index.html — wiring up Surprise me…"));
  await page.evaluate((n) => window.agentLine("tool", '  resolve_feedback { note: "' + n + '" }'), NOTE.slice(0, 38) + "…");
  await patch(good.id, { status: "resolved", note: NOTE });
  await page.evaluate(() => window.agentLine("res ok", "  ← ✓ resolved"));
  await hold(400);

  if (!hero && bad) {
    await say(page, "But it doesn't take every comment as an order.");
    await page.evaluate((s) => window.agentLine("res", '#2  price  "' + s + '"'), bBody);
    await page.evaluate(() => window.agentLine("note", "  blinking text fails WCAG 2.2.2 — not shipping that"));
    await page.evaluate(() => window.agentLine("tool", '  triage_feedback { status: "declined", note: "WCAG 2.2.2…" }'));
    await patch(bad.id, { status: "declined", note: NOTE_DECLINE });
    await page.evaluate(() => window.agentLine("res", "  ← ⊘ declined · reason sent to the reviewer"));
    await say(page, "It fixes the good one — and challenges the bad, with a reason.");
  } else {
    await say(page, "It used the element and route to find the fix.");
  }
  await hold(hero ? 500 : 900);

  /* ---- Act 3 — the reviewer returns: one green, one grey ---- */
  await goto(page, demoUrl, { widget: true });
  await actor(page, "reviewer");
  await say(page, hero ? "Dave comes back — his pin has turned green." : "Dave comes back — and both pins answered him.");
  await hold(1900); // receipts poll flips the pins
  await scrollInto(page, "#surprise-me");
  const green = await shadowBox(page, ".pin.resolved");
  await say(page, "Green — fixed. Hover for the note.");
  if (green) { await glide(page, green.x, green.y, 900); await hold(hero ? 2600 : 2200); }

  if (!hero) {
    await scrollInto(page, ".price");
    const grey = await shadowBox(page, ".pin.declined");
    await say(page, "Grey — declined, with the reason he's owed.");
    if (grey) { await glide(page, grey.x, grey.y, 900); await hold(2400); }
    await say(page, "The loop closed both ways. Nobody retyped anything.");
    await glide(page, 500, 420, 500);
    await hold(1600);
    // Bookend: review was part of the build — and it leaves for prod.
    await actor(page, "builder");
    await say(page, "And when it ships for real, one line takes it back out.");
    await hold(2000);
  } else {
    await say(page, "The loop closed — nobody retyped anything.");
    await hold(1600);
  }
}

/* --------------------------- record + encode ----------------------------- */

async function recordOnce(hero, out) {
  PACE = hero ? 0.62 : 1;
  rmSync(VIDEO_DIR, { recursive: true, force: true });
  mkdirSync(VIDEO_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1000, height: 700 },
    recordVideo: { dir: VIDEO_DIR, size: { width: 1000, height: 700 } },
  });
  const page = await context.newPage();
  // Paint the dark surfaces dark from the very first frame, so navigating to
  // them never flashes white before their own CSS loads.
  await page.addInitScript(() => {
    if (/console\.html$/.test(location.pathname)) {
      document.documentElement.style.background = "#0f1115";
    }
  });
  await film(page, hero);
  await context.close(); // flush video
  await browser.close();
  const webm = readdirSync(VIDEO_DIR).find((f) => f.endsWith(".webm"));
  console.log("· encoding", hero ? "hero" : "full", "→", out);
  execSync(
    `ffmpeg -y -i "${resolve(VIDEO_DIR, webm)}" -vf "fps=12,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" -loop 0 "${out}"`,
    { stdio: "inherit" },
  );
  rmSync(VIDEO_DIR, { recursive: true, force: true });
  console.log("✓ wrote", out);
}

async function main() {
  const arg = process.argv[2];
  const doHero = arg === "--hero" || arg === "--both" || !arg;
  const doFull = arg === "--full" || arg === "--both" || !arg;

  console.log("· starting film set (page :" + PAGE_PORT + ", worker :" + WORKER_PORT + ")");
  const server = spawn("python3", ["-m", "http.server", String(PAGE_PORT)], { cwd: ROOT, stdio: "ignore" });
  const worker = spawn("npx", ["wrangler", "dev", "--port", String(WORKER_PORT), "--local"], {
    cwd: resolve(ROOT, "destinations/cloudflare"), stdio: "ignore",
  });
  const cleanup = () => { server.kill(); worker.kill(); };
  process.on("exit", cleanup);

  try {
    await waitHttp(`http://localhost:${PAGE_PORT}/demo/index.html`);
    await waitHttp(`http://localhost:${WORKER_PORT}/`);
    if (doFull) await recordOnce(false, resolve(ROOT, "docs/demo-video.gif"));
    if (doHero) await recordOnce(true, resolve(ROOT, "docs/demo-hero.gif"));
  } finally {
    cleanup();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
