/**
 * tyrekick CLI — shared helpers and management commands.
 *
 * Zero runtime dependencies (Node built-ins only) — this ships in every
 * `npx tyrekick`, so keep it tiny. The interactive menu (tui.mjs) and the
 * flag-driven router (cli.mjs) both call into here.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { basename, resolve, dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

// Version comes from package.json so it can never drift from what npm serves.
// Guarded so the module stays importable from test runners where import.meta.url
// isn't a file: URL (the CLI itself always resolves it correctly).
function readVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}
export const VERSION = readVersion();

// The CDN pin tracks the minor line deliberately (patches apply automatically).
export const CDN = `https://cdn.jsdelivr.net/npm/tyrekick@${VERSION.split(".").slice(0, 2).join(".")}/dist/tyrekick.js`;

// Sidecar written only while the widget is disabled; holds the exact tag block
// so `enable` restores it byte-for-byte. Absent when the widget is live.
export const DISABLED_FILE = ".tyrekick.disabled";

const HTML_CANDIDATES = ["index.html", "public/index.html", "dist/index.html", "src/index.html"];

// Wrangler config locations we look for when tearing down the worker.
const WRANGLER_CANDIDATES = [
  "destinations/cloudflare/wrangler.local.toml",
  "destinations/cloudflare/wrangler.toml",
  "wrangler.local.toml",
  "wrangler.toml",
];

// Where a framework/ESM install (the `import { init } from "tyrekick"` mount,
// issue #7) is likely to live, and how far / what to skip while scanning.
const SRC_ROOTS = [".", "src", "app", "components", "src/components", "src/app", "lib"];
const SRC_EXTS = new Set([".tsx", ".jsx", ".ts", ".js", ".mjs", ".vue", ".svelte"]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt", ".svelte-kit",
  "coverage", ".wrangler", ".cache", "out", "test", "tests", "__tests__",
]);
const SCAN_DEPTH = 4;
const SCAN_FILE_LIMIT = 3000; // hard cap so a huge repo can't stall the scan

export function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

export function gitSha() {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export function isDiscord(url) {
  return /discord(app)?\.com\/api\/webhooks\//.test(url);
}

export function detectHtml(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) fail(`--file ${explicit} does not exist`);
    return explicit;
  }
  const found = HTML_CANDIDATES.filter((c) => existsSync(c));
  if (found.length === 0) {
    fail("No index.html found (looked in ., public/, dist/, src/). Point me at one with --file <path>.");
  }
  return found[0];
}

// ---------------------------------------------------------------------------
// Widget tag: find / parse / strip
// ---------------------------------------------------------------------------

// Match a tyrekick <script> block (optionally preceded by its comment line).
// Identified by a tyrekick CDN src OR a data-webhook attribute, so it also
// catches hand-written tags. Lazy body match stops at the first </script>.
const TAG_RE =
  /(?:[^\S\n]*<!--\s*Tyrekick[^\n]*-->\s*\r?\n)?[^\S\n]*<script\b[^>]*?(?:src="[^"]*tyrekick|data-webhook=)[\s\S]*?<\/script>[^\S\n]*\r?\n?/i;

export function stripTag(html) {
  const m = html.match(TAG_RE);
  if (!m) return { html, block: null };
  return { html: html.slice(0, m.index) + html.slice(m.index + m[0].length), block: m[0] };
}

export function parseConfig(block) {
  if (!block) return {};
  const attr = (name) => {
    const m = block.match(new RegExp(`data-${name}="([^"]*)"`, "i"));
    return m ? m[1] : null;
  };
  const src = block.match(/src="([^"]*)"/i);
  return {
    webhook: attr("webhook"),
    transport: attr("transport") || "json",
    project: attr("project-name"),
    appVersion: attr("app-version"),
    reviewKey: attr("review-key"),
    src: src ? src[1] : null,
  };
}

// A framework/ESM install imports the package AND calls init() — the mount
// from issue #7. Config lives in the init({...}) argument, not in data-attrs.
export function isEsmMount(src) {
  return (
    /\binit\s*\(/.test(src) &&
    /(from\s*["']tyrekick["']|import\(\s*["']tyrekick["']\s*\))/.test(src)
  );
}

export function parseEsmConfig(src) {
  const at = src.search(/\binit\s*\(/);
  const scope = at >= 0 ? src.slice(at, at + 800) : src;
  const grab = (key) => {
    const m = scope.match(new RegExp(`${key}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`));
    return m ? m[1] : null;
  };
  return {
    webhook: grab("webhook"),
    project: grab("projectName"),
    appVersion: grab("appVersion"),
    transport: grab("transport") || "json",
    reviewKey: grab("reviewKey"),
  };
}

/** Depth-bounded scan of the usual source roots for the ESM mount. */
function scanEsm() {
  const seen = new Set();
  let budget = SCAN_FILE_LIMIT;
  const walk = (dir, depth) => {
    if (depth > SCAN_DEPTH || budget <= 0) return null;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    // Files first (a mount in this dir beats descending), then subdirs.
    for (const e of entries) {
      if (!e.isFile()) continue;
      const dot = e.name.lastIndexOf(".");
      if (dot < 0 || !SRC_EXTS.has(e.name.slice(dot))) continue;
      if (--budget <= 0) return null;
      const full = join(dir, e.name);
      let src;
      try {
        if (statSync(full).size > 262144) continue; // skip >256KB
        src = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (!isEsmMount(src)) continue;
      const rel = full.startsWith("./") ? full.slice(2) : full;
      const line = src.slice(0, src.search(/\binit\s*\(/)).split("\n").length;
      return { file: rel, line, config: parseEsmConfig(src) };
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const hit = walk(join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  for (const root of SRC_ROOTS) {
    if (!existsSync(root)) continue;
    const real = resolve(root);
    if (seen.has(real)) continue;
    seen.add(real);
    const hit = walk(root, 0);
    if (hit) return hit;
  }
  return null;
}

/**
 * Locate the widget across the project. Returns one of:
 *   { state: "disabled",  kind: "tag", file, block, config }  — sidecar present
 *   { state: "installed", kind: "tag", file, block, config }  — <script> tag in HTML
 *   { state: "installed", kind: "esm", file, line, config }   — import { init } mount (#7)
 *   { state: "none" }                                         — nothing found
 */
export function findWidget() {
  if (existsSync(DISABLED_FILE)) {
    try {
      const rec = JSON.parse(readFileSync(DISABLED_FILE, "utf8"));
      if (rec && rec.block) {
        return { state: "disabled", kind: "tag", file: rec.file, block: rec.block, config: parseConfig(rec.block) };
      }
    } catch {
      /* fall through to a live scan if the sidecar is corrupt */
    }
  }
  for (const f of HTML_CANDIDATES) {
    if (!existsSync(f)) continue;
    const { block } = stripTag(readFileSync(f, "utf8"));
    if (block) return { state: "installed", kind: "tag", file: f, block, config: parseConfig(block) };
  }
  const esm = scanEsm();
  if (esm) return { state: "installed", kind: "esm", file: esm.file, line: esm.line, block: null, config: esm.config };
  return { state: "none", kind: null, file: null, block: null, config: {} };
}

// ---------------------------------------------------------------------------
// Status probes
// ---------------------------------------------------------------------------

/** Unauthenticated worker health check via the open /receipts endpoint. */
export async function workerReachable(webhook) {
  if (!webhook) return null;
  const base = webhook.replace(/\/feedback\/?$/, "");
  try {
    const res = await fetch(`${base}/receipts?ids=00000000-0000-0000-0000-000000000000`, {
      signal: AbortSignal.timeout(4000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Is the tyrekick MCP server registered with Claude Code (and does it carry a token)? */
export function mcpStatus() {
  try {
    const out = execSync("claude mcp get tyrekick", { stdio: ["ignore", "pipe", "ignore"] }).toString();
    return { registered: true, hasToken: /TYREKICK_TOKEN/.test(out), cliMissing: false };
  } catch (e) {
    // ENOENT => the `claude` CLI isn't installed; anything else => not registered.
    return { registered: false, hasToken: false, cliMissing: e && e.code === "ENOENT" };
  }
}

/**
 * Parse the two Workers Rate Limiting bindings out of a wrangler config's text.
 * Handles both the [[unsafe.bindings]] form (`name = "…"`) and the modern
 * [[ratelimit]] form (`binding = "…"`). Pure — no I/O — so it's unit-tested
 * over fixture strings. Returns { ingest, read, configured }.
 */
export function parseRateLimit(toml) {
  const grab = (id) => {
    const re = new RegExp(
      `(?:name|binding)\\s*=\\s*"${id}"[\\s\\S]{0,240}?simple\\s*=\\s*\\{[^}]*?limit\\s*=\\s*(\\d+)[^}]*?period\\s*=\\s*(\\d+)`,
      "i",
    );
    const m = toml.match(re);
    return m ? { limit: Number(m[1]), period: Number(m[2]) } : null;
  };
  const ingest = grab("INGEST_LIMITER");
  const read = grab("READ_LIMITER");
  return { ingest, read, configured: Boolean(ingest || read) };
}

/** Read the first local wrangler config and parse its rate-limit bindings. */
function readRateLimit() {
  const path = findWrangler();
  if (!path) return { found: false, configured: false, ingest: null, read: null };
  try {
    return { found: true, ...parseRateLimit(readFileSync(path, "utf8")) };
  } catch {
    return { found: false, configured: false, ingest: null, read: null };
  }
}

/**
 * Best-effort probe of which secrets the deployed worker has — the only way to
 * know whether AI auto-reply / shared review are wired on the WORKER side, since
 * secrets never appear in the config. Only meaningful where a local wrangler
 * config exists (i.e. you have the worker here). Degrades to { known:false } on
 * anything — no config, wrangler missing, not authed. Never prompts (stdin
 * ignored), so it can't hang on a login flow.
 */
async function probeWorkerSecrets() {
  const cfg = findWrangler();
  if (!cfg) return { known: false, names: new Set() };
  try {
    const out = execSync(`npx --no-install wrangler secret list --config ${cfg}`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
    }).toString();
    const arr = JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1));
    return { known: true, names: new Set(arr.map((x) => x && x.name).filter(Boolean)) };
  } catch {
    return { known: false, names: new Set() };
  }
}

export async function gatherStatus() {
  const widget = findWidget();
  const cfg = widget.config || {};
  const transport = cfg.transport || "json";
  const worker = transport === "json" && cfg.webhook ? await workerReachable(cfg.webhook) : null;
  const mcp = mcpStatus();
  // Public-share posture — worker (json) transport only: shared review from the
  // widget key, rate limiting from the local wrangler config, and (best-effort)
  // which secrets the worker actually has.
  const reviewKey = cfg.reviewKey || null;
  const rateLimit =
    transport === "json" ? readRateLimit() : { found: false, configured: false, ingest: null, read: null };
  const secrets = transport === "json" ? await probeWorkerSecrets() : { known: false, names: new Set() };
  return {
    widget,
    cfg,
    transport,
    worker,
    mcp,
    reviewKey,
    rateLimit,
    secrets,
    project: cfg.project || basename(resolve(".")),
  };
}

/** Turn a status object into [label, value] rows for printing / rendering. */
export function renderStatus(s) {
  const rows = [];
  if (s.widget.state === "installed") {
    const how = s.widget.kind === "esm" ? "ESM mount" : "script tag";
    rows.push(["Widget", `✔ installed · ${how} (${s.widget.file})`]);
  } else if (s.widget.state === "disabled") rows.push(["Widget", "⏸ disabled (data kept)"]);
  else rows.push(["Widget", "✗ not installed"]);

  if (s.transport === "discord") rows.push(["Dest", "Discord (write-only)"]);
  else if (!s.cfg.webhook) rows.push(["Worker", "— no webhook"]);
  else rows.push(["Worker", s.worker ? "✔ reachable" : "✗ unreachable"]);

  if (s.mcp.cliMissing) rows.push(["MCP", "? claude CLI not found"]);
  else if (s.mcp.registered) rows.push(["MCP", s.mcp.hasToken ? "✔ registered (token set)" : "✔ registered"]);
  else rows.push(["MCP", "✗ not registered"]);

  // Public-share posture — only meaningful on the worker (json) transport.
  if (s.transport === "json") {
    // Shared review: driven by the widget key (the client half that turns it
    // on). If we could read the worker's secrets and it has none, flag the
    // mismatch — the widget would send a key the worker rejects.
    if (s.reviewKey) {
      const workerMissing =
        s.secrets && s.secrets.known && !s.secrets.names.has("TYREKICK_REVIEW_KEY");
      rows.push([
        "Shared review",
        workerMissing
          ? "⚠ widget sends a key but the worker has none — /shared will 401"
          : "⚠ ON — anyone with the link can read every comment",
      ]);
    } else {
      rows.push(["Shared review", "off — reviewers see only their own pins"]);
    }

    // Rate limiting: from the local wrangler config, when there is one. Omitted
    // for a widget-only project where the worker config isn't present locally.
    if (s.rateLimit && s.rateLimit.found) {
      if (s.rateLimit.configured) {
        const bits = [];
        if (s.rateLimit.ingest) bits.push(`${s.rateLimit.ingest.limit}/${s.rateLimit.ingest.period}s ingest`);
        if (s.rateLimit.read) bits.push(`${s.rateLimit.read.limit}/${s.rateLimit.read.period}s read`);
        rows.push(["Rate limit", `✔ on — ${bits.join(", ")}`]);
      } else {
        rows.push(["Rate limit", "✗ off — add it before a public share"]);
      }
    }

    // AI auto-reply: only knowable via the secret probe (no config artifact).
    if (s.secrets && s.secrets.known) {
      rows.push([
        "AI reply",
        s.secrets.names.has("ANTHROPIC_API_KEY")
          ? "✔ on · confirm an Anthropic spend limit is set"
          : "off — set ANTHROPIC_API_KEY on the worker to enable",
      ]);
    } else if (s.rateLimit && s.rateLimit.found) {
      // The worker config is here but we couldn't read its secrets.
      rows.push(["AI reply", "? worker-side — run `wrangler secret list` to confirm"]);
    }
  }

  return rows;
}

/**
 * One-line public-share readiness verdict, printed under the status rows. Flags
 * the dangerous combo (shared review on = every comment is public) and the
 * missing guard (no rate limiting), plus the spend-limit reminder when AI reply
 * is on. Returns null when nothing needs flagging. Pure.
 */
export function readinessNote(s) {
  if (s.transport !== "json") return null; // worker-only concepts
  const items = [];
  const sharedReview = !!s.reviewKey;
  const aiReply = !!(s.secrets && s.secrets.known && s.secrets.names.has("ANTHROPIC_API_KEY"));

  // The one dangerous COMBINATION the per-knob rows can't see on their own: AI
  // auto-reply is safe only because a reply is author-only (fetched by the
  // unguessable capability UUID), and shared review is exactly what lets another
  // reviewer read that thread. Each setting is fine alone; together the AI reply
  // leaks to everyone holding the link. See CONTRACT.md (2026-07-23 addendum).
  if (sharedReview && aiReply)
    items.push(
      "shared review AND AI auto-reply are BOTH on — an AI reply is meant for the comment's author alone, but shared review lets any reviewer read the thread. Turn one off.",
    );
  else if (sharedReview)
    items.push("shared review is ON — only for a private link, never a public URL");

  if (s.rateLimit && s.rateLimit.found && !s.rateLimit.configured)
    items.push("no rate limiting — add it before sharing publicly");
  if (aiReply)
    items.push("AI auto-reply is on — confirm an Anthropic workspace spend limit");
  if (!items.length) return null;
  return "Before a public share:\n" + items.map((w) => `    · ${w}`).join("\n");
}

// ---------------------------------------------------------------------------
// Shared side-effecting bits (also used by init)
// ---------------------------------------------------------------------------

export async function sendTest(webhook, transport, project, appVersion) {
  const body =
    transport === "discord"
      ? { content: `**${project} ${appVersion}** — Tyrekick\nTest comment: the widget is wired up. Real feedback will look like this.` }
      : {
          schema: 2,
          id: crypto.randomUUID(),
          created_at: new Date().toISOString(),
          project_name: project,
          app_version: appVersion,
          route: "/",
          url: "tyrekick-init-test",
          body: "Test comment from `tyrekick` — the widget is wired up.",
          reviewer_name: "tyrekick init",
          session_id: crypto.randomUUID(),
          anchor: {
            x_pct: 0, y_pct: 0, selector: null, viewport: { w: 0, h: 0 },
            element: null, context: { heading: null, landmark: null },
          },
          env: { user_agent: `tyrekick-init/${VERSION}`, language: "en", screen: { w: 0, h: 0 }, dpr: 1, dark: false, touch: false },
          page_errors: [],
        };
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
  if (transport === "json") {
    const json = await res.json().catch(() => null);
    if (json && json.ok === false) throw new Error(json.error || "worker said ok:false");
  }
}

/** Print the `claude mcp add` line for the agent loop (worker destinations only). */
export function printMcpAdd(webhook) {
  const base = webhook.replace(/\/feedback\/?$/, "");
  console.log(
    `Register the agent loop (fill in your token):\n` +
      `  claude mcp add tyrekick \\\n` +
      `    --env TYREKICK_URL=${base} \\\n` +
      `    --env TYREKICK_TOKEN=<your token> \\\n` +
      `    -- npx tyrekick-mcp\n` +
      `Then: "list the open feedback and fix what people flagged".`,
  );
}

// ---------------------------------------------------------------------------
// Management commands
// ---------------------------------------------------------------------------

export async function cmdStatus() {
  const s = await gatherStatus();
  console.log(`\n  tyrekick ${VERSION}  ·  ${s.project}\n`);
  for (const [k, v] of renderStatus(s)) console.log(`  ${k.padEnd(13)} ${v}`);
  const note = readinessNote(s);
  if (note) console.log(`\n  ${note}`);
  console.log("");
}

/** Remove the widget from the page but keep worker, token, MCP, and all data. Reversible. */
export function cmdDisable() {
  const w = findWidget();
  if (w.state === "disabled") {
    console.log("· already disabled — feedback data untouched. Run `tyrekick enable` to restore.");
    return;
  }
  if (w.state === "none") {
    console.log("· no tyrekick widget found to disable.");
    return;
  }
  if (w.kind === "esm") {
    esmGuidance("disable", w);
    return;
  }
  const { html, block } = stripTag(readFileSync(w.file, "utf8"));
  writeFileSync(w.file, html);
  writeFileSync(
    DISABLED_FILE,
    JSON.stringify({ file: w.file, block, disabledAt: new Date().toISOString() }, null, 2) + "\n",
  );
  console.log(`⏸ widget removed from ${w.file} — nothing renders now.`);
  console.log(`  Worker, token, MCP, and all feedback data are untouched.`);
  console.log(`  Re-enable any time:  npx tyrekick enable`);
  console.log(`  (tip: git-ignore ${DISABLED_FILE} if you don't want it committed.)`);
}

/**
 * ESM/framework installs live in user-owned source (often a <TyrekickWidget/>
 * mount rendered from a layout). We deliberately do NOT auto-edit that source —
 * a bad rewrite could break the build — so we point precisely at it instead.
 */
function esmGuidance(verb, w) {
  const where = w.line ? `${w.file}:${w.line}` : w.file;
  console.log(`· found a framework/ESM install (import { init }) at ${where}.`);
  console.log(`  I won't edit framework source automatically (it can break your build).`);
  console.log(`  To ${verb} it, in your own code:`);
  console.log(`    · remove (or stop rendering) the component that calls init() — e.g. <TyrekickWidget/>,`);
  console.log(`    · or comment out the init({ … }) call in ${w.file}.`);
  if (verb === "disable") {
    console.log(`  The worker, token, MCP, and all feedback data stay untouched.`);
  }
}

/** Restore a previously disabled widget from the sidecar. */
export function cmdEnable() {
  if (!existsSync(DISABLED_FILE)) {
    console.log("· nothing to enable — no disabled widget on record.");
    return;
  }
  let rec;
  try {
    rec = JSON.parse(readFileSync(DISABLED_FILE, "utf8"));
  } catch {
    fail(`${DISABLED_FILE} is unreadable — delete it or restore the tag by hand.`);
  }
  if (!rec.file || !rec.block) fail(`${DISABLED_FILE} is missing its recorded tag.`);
  if (!existsSync(rec.file)) fail(`Recorded file ${rec.file} no longer exists.`);

  let html = readFileSync(rec.file, "utf8");
  if (stripTag(html).block) {
    unlinkSync(DISABLED_FILE);
    console.log(`· widget already present in ${rec.file}; cleared the disabled record.`);
    return;
  }
  html = html.includes("</body>") ? html.replace("</body>", `${rec.block}</body>`) : html + "\n" + rec.block;
  writeFileSync(rec.file, html);
  unlinkSync(DISABLED_FILE);
  console.log(`✔ widget re-enabled in ${rec.file}.`);
}

/**
 * Remove tyrekick. Default: local wiring only (strip tag + deregister MCP),
 * leaving the worker and every feedback record intact. With { teardown: true }
 * it additionally deletes the Cloudflare worker/KV/secret — guarded by a
 * type-the-project-name confirmation because that destroys all feedback.
 */
export async function cmdRemove({ teardown = false, yes = false } = {}) {
  const w = findWidget();
  const project = w.config?.project || basename(resolve("."));

  // 1. Local widget wiring.
  if (w.state === "disabled") {
    unlinkSync(DISABLED_FILE);
    console.log("✔ removed the disabled-widget record.");
  } else if (w.state === "installed" && w.kind === "esm") {
    esmGuidance("remove", w);
  } else if (w.state === "installed") {
    writeFileSync(w.file, stripTag(readFileSync(w.file, "utf8")).html);
    console.log(`✔ stripped the widget tag from ${w.file}.`);
  } else {
    console.log("· no widget tag found (already gone).");
  }

  // 2. MCP registration.
  const mcp = mcpStatus();
  if (mcp.registered) {
    try {
      execSync("claude mcp remove tyrekick", { stdio: ["ignore", "ignore", "ignore"] });
      console.log("✔ unregistered the tyrekick MCP server.");
    } catch {
      console.log("⚠ couldn't run `claude mcp remove tyrekick` — remove it manually.");
    }
  } else if (!mcp.cliMissing) {
    console.log("· MCP not registered (nothing to unregister).");
  }

  // 3. Cloud teardown (opt-in, destructive).
  if (!teardown) {
    console.log("\nLocal wiring removed. The worker, its KV store, and all feedback data are left intact.");
    console.log("To also delete the cloud worker and its data:  npx tyrekick remove --teardown");
    return;
  }
  await teardownCloud({ project, yes });
}

function findWrangler() {
  return WRANGLER_CANDIDATES.find((p) => existsSync(p)) || null;
}

function readToml(path, key) {
  const m = readFileSync(path, "utf8").match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m"));
  return m ? m[1] : null;
}

async function teardownCloud({ project, yes }) {
  const toml = findWrangler();
  const workerName = toml ? readToml(toml, "name") || project : project;
  const binding = toml ? readToml(toml, "binding") || "FEEDBACK" : "FEEDBACK";

  if (!toml) {
    console.log(
      `\n⚠ No wrangler config found locally, so I can't tear the worker down for you.\n` +
        `  From the folder you deployed the worker in, run:\n` +
        `    npx wrangler delete\n` +
        `    npx wrangler kv namespace delete --binding ${binding}\n` +
        `    npx wrangler secret delete TYREKICK_TOKEN\n` +
        `  These permanently delete the worker and every feedback record.`,
    );
    return;
  }

  console.log(
    `\n⚠ DESTRUCTIVE: this deletes worker "${workerName}", its KV namespace (binding ${binding}),\n` +
      `  and the TYREKICK_TOKEN secret. Every stored feedback record is lost and cannot be recovered.`,
  );

  if (!yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const typed = (await rl.question(`  Type the project name "${project}" to confirm: `)).trim();
    rl.close();
    if (typed !== project) {
      console.log("✗ names didn't match — aborted. Nothing was deleted in the cloud.");
      return;
    }
  }

  const dir = dirname(toml);
  const run = (label, cmd) => {
    try {
      execSync(cmd, { stdio: "inherit", cwd: dir });
      console.log(`✔ ${label}`);
    } catch {
      console.log(`⚠ ${label} failed — finish it manually with wrangler.`);
    }
  };
  run("deleted worker", `npx wrangler delete`);
  run("deleted KV namespace", `npx wrangler kv namespace delete --binding ${binding}`);
  run("deleted token secret", `npx wrangler secret delete TYREKICK_TOKEN`);
  console.log("\nCloud teardown complete.");
}
