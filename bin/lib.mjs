/**
 * tyrekick CLI — shared helpers and management commands.
 *
 * Zero runtime dependencies (Node built-ins only) — this ships in every
 * `npx tyrekick`, so keep it tiny. The interactive menu (tui.mjs) and the
 * flag-driven router (cli.mjs) both call into here.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { basename, resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
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

// Per-deployment pointer written at spin-up (slug + worker URL + live URL) so
// dashboards can find the worker. Survives a plain `remove` — the worker and its
// feedback are still there — and is deleted only by a successful --teardown.
export const PROJECT_CONFIG = ".tyrekick.json";

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

// ---------------------------------------------------------------------------
// Link preview
// ---------------------------------------------------------------------------
//
// A review link is pasted into Slack, Discord or a DM — that paste IS the ask.
// If the page carries no Open Graph tags the unfurl is a bare hostname, which
// reads like a broken link rather than an invitation. Reviewers who do not
// recognise it do not click.
//
// This only inspects and reports. Writing tags is `init`'s job, and it never
// overwrites what an author already set.

/** Read the content of a <meta> by property= or name=, whichever it uses. */
function metaContent(html, key) {
  const re = new RegExp(
    `<meta[^>]*(?:property|name)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`,
    "i",
  );
  const tag = html.match(re);
  if (!tag) return null;
  const c = tag[0].match(/content=["']([^"']*)["']/i);
  return c ? c[1].trim() || null : null;
}

/**
 * What a chat client will show when this page's URL is pasted.
 *
 * Falls back the way the crawlers do: og:title then <title>, og:description
 * then the meta description. `missing` lists only what is worth fixing — an
 * image is optional but it is the difference between a line of text and a card.
 */
export function linkPreview(html) {
  const ogTitle = metaContent(html, "og:title");
  const ogDesc = metaContent(html, "og:description");
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = ogTitle || (titleTag ? titleTag[1].trim() || null : null);
  const description = ogDesc || metaContent(html, "description");
  const image = metaContent(html, "og:image");
  const url = metaContent(html, "og:url");
  const card = metaContent(html, "twitter:card");

  const missing = [];
  if (!title) missing.push("title");
  if (!description) missing.push("description");
  if (!image) missing.push("image");

  return {
    title,
    description,
    image,
    url,
    card,
    /** Any Open Graph at all, as opposed to bare HTML the crawler guessed from. */
    hasOg: Boolean(ogTitle || ogDesc || image || url),
    missing,
    /** A title and a description is the floor for an unfurl that reads as deliberate. */
    usable: Boolean(title && description),
  };
}

/**
 * Canonicalise a review URL for og:url, or return null if it is not one.
 *
 * A wrong og:url is worse than none — crawlers treat it as the canonical
 * address, so a typo can point every unfurl at the wrong page. Hence: absolute
 * http(s) only, no credentials, and the fragment dropped (never part of what a
 * crawler canonicalises). A bare host is accepted and assumed https, because
 * that is how people type a deploy URL.
 */
export function canonicalUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // A dotted hostname, which rules out `localhost` and other single-label names.
  // ponytail: not a public-host check — 127.0.0.1 and 192.168.x.x still pass.
  // Tighten to reject loopback/RFC1918/.local if a wrong-but-plausible og:url
  // turns out to bite in practice.
  if (!u.hostname || !u.hostname.includes(".")) return null;
  if (u.username || u.password) return null;
  u.hash = "";
  return u.href;
}

/**
 * Minimal Open Graph tags to add to a page that has none.
 *
 * Deliberately derived from what the page already says rather than invented.
 * og:url is included only when the caller passes one — `init` cannot guess a
 * deploy URL, but it can be told (`--url`). og:image is still omitted: an
 * installer has no artwork to point at, and `status` reports it as the next
 * improvement.
 */
export function previewTags({ title, description, url }) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const out = [`  <!-- Tyrekick: so a shared review link unfurls as an invitation, not a bare URL -->`];
  out.push(`  <meta property="og:type" content="website">`);
  if (title) {
    out.push(`  <meta property="og:title" content="${esc(title)}">`);
    out.push(`  <meta name="twitter:title" content="${esc(title)}">`);
  }
  if (description) {
    out.push(`  <meta property="og:description" content="${esc(description)}">`);
    out.push(`  <meta name="twitter:description" content="${esc(description)}">`);
  }
  const canonical = canonicalUrl(url);
  if (canonical) out.push(`  <meta property="og:url" content="${esc(canonical)}">`);
  out.push(`  <meta name="twitter:card" content="summary">`);
  return out.join("\n") + "\n";
}

/** The og:url line on its own, for a page that already has other og: tags. */
export function ogUrlTag(url) {
  const canonical = canonicalUrl(url);
  if (!canonical) return null;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  return `  <meta property="og:url" content="${esc(canonical)}">\n`;
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
/** `.tyrekick.json` if it is present and parseable, else an empty object. */
export function readProjectConfig() {
  try {
    const v = JSON.parse(readFileSync(PROJECT_CONFIG, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * Remember which file the widget went into. `init --file` accepts any path, but
 * every later command re-guessed from a fixed list of four conventional names —
 * so a project whose page is `nz-health-regions.html` was told its own install
 * was missing. Merges: the skill writes slug/workerUrl/liveUrl into this file too.
 */
export function recordWidgetFile(file) {
  try {
    const cfg = readProjectConfig();
    if (cfg.file === file) return false;
    cfg.file = file;
    writeFileSync(PROJECT_CONFIG, JSON.stringify(cfg, null, 2) + "\n");
    return true;
  } catch {
    return false; // an unwritable directory must never fail an install
  }
}

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
  // The recorded file first, then the conventional names. A recorded file that
  // no longer holds a tag falls through rather than reporting "not installed".
  const recorded = readProjectConfig().file;
  const candidates = recorded ? [recorded, ...HTML_CANDIDATES.filter((c) => c !== recorded)] : HTML_CANDIDATES;
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    const { block } = stripTag(readFileSync(f, "utf8"));
    if (block) return { state: "installed", kind: "tag", file: f, block, config: parseConfig(block) };
  }
  const esm = scanEsm();
  if (esm) return { state: "installed", kind: "esm", file: esm.file, line: esm.line, block: null, config: esm.config };
  return { state: "none", kind: null, file: null, block: null, config: {} };
}

// ---------------------------------------------------------------------------
// Deployment registry — ~/.tyrekick/deployments.json
// ---------------------------------------------------------------------------
//
// A bookmark file, not a database. It answers exactly one question: which
// worker URLs has this machine ever wired up, so `status --all` knows what to
// probe. Three fields, no cached window state — everything printed comes from a
// live probe at display time, so staleness is a non-event rather than a sync
// problem. It holds no secrets by construction: a worker base URL is already
// embedded in the reviewed page, and `project` is a display label.

/** The worker BASE for a configured webhook: `/feedback` and trailing slashes off. */
const baseUrl = (webhook) => String(webhook).replace(/\/feedback\/?$/, "").replace(/\/+$/, "");

export const REGISTRY_PATH = join(homedir(), ".tyrekick", "deployments.json");

/**
 * Read the registry. Never throws: a missing, unreadable, corrupt or
 * unknown-version file all read as empty, because a broken bookmark file must
 * never break `tyrekick status`.
 */
export function readRegistry() {
  try {
    const r = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
    if (!r || r.version !== 1 || !Array.isArray(r.deployments)) return { version: 1, deployments: [] };
    return { version: 1, deployments: r.deployments.filter((d) => d && typeof d.url === "string") };
  } catch {
    return { version: 1, deployments: [] };
  }
}

// ponytail: last-write-wins whole-file rewrite, no lockfile — single-user CLI.
// Two concurrent `tyrekick status` runs could drop one bookmark; the next run
// re-adds it. Upgrade path is write-temp-then-rename if that ever matters.
function writeRegistry(reg) {
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Upsert by normalised base URL. Returns true only when a NEW entry was
 * appended. Discord destinations are never recorded — they are write-only, so
 * there is nothing to close. Silent on every failure: a bookmark write must
 * never fail the command that happened to trigger it.
 */
export function rememberDeployment(webhook, project) {
  try {
    if (typeof webhook !== "string" || !/^https?:\/\//i.test(webhook)) return false;
    if (isDiscord(webhook)) return false;
    const url = baseUrl(webhook);
    const reg = readRegistry();
    const existing = reg.deployments.find((d) => d.url === url);
    if (existing) {
      // `project` is refreshed (a folder gets renamed); `added_at` never is.
      if (project && existing.project !== project) {
        existing.project = project;
        writeRegistry(reg);
      }
      return false;
    }
    reg.deployments.push({ url, project: project || null, added_at: new Date().toISOString() });
    writeRegistry(reg);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop an entry. Called only after a successful `remove --teardown`, where the
 * worker genuinely no longer exists. A failed probe never prunes: a deleted
 * worker, a laptop on a plane and a DNS blip look identical from here.
 */
function forgetDeployment(webhook) {
  try {
    if (typeof webhook !== "string") return;
    const url = baseUrl(webhook);
    const reg = readRegistry();
    const kept = reg.deployments.filter((d) => d.url !== url);
    if (kept.length !== reg.deployments.length) writeRegistry({ version: 1, deployments: kept });
  } catch {
    /* a bookmark file is never worth failing a teardown over */
  }
}

// ---------------------------------------------------------------------------
// Status probes
// ---------------------------------------------------------------------------

/**
 * Unauthenticated worker probe via the open /receipts endpoint: reachability
 * and the review window in one request. A worker deployed before the window
 * existed sends no `review` key and reads as open, which is exactly what it is.
 */
/**
 * The management token for one deployment, from the environment only — the
 * registry deliberately holds no secrets. `TYREKICK_TOKEN_<project>` first
 * (non-alphanumerics -> `_`), then a bare `TYREKICK_TOKEN`. Null when neither is
 * set, which is a normal state: the unauthenticated probe still works without it.
 */
export function tokenFor(project) {
  const key = project ? `TYREKICK_TOKEN_${String(project).replace(/[^A-Za-z0-9]/g, "_")}` : null;
  return (key && process.env[key]) || process.env.TYREKICK_TOKEN || null;
}

/**
 * How many comments are still open. Null means "not known" — no token, or the
 * worker refused it — which is reported as a dash, never as zero. Zero open and
 * unreadable are different facts and must not print the same.
 */
export async function probeOpen(webhook, token) {
  if (!webhook || !token) return null;
  try {
    const res = await fetch(`${baseUrl(webhook)}/feedback?status=open&limit=200`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!body || body.ok !== true || !Array.isArray(body.items)) return null;
    return body.items.filter((x) => x && x.status === "open");
  } catch {
    return null;
  }
}

export async function probeWindow(webhook) {
  const unreachable = { reachable: false, gated: false, state: "open", open_until: null };
  if (!webhook) return unreachable;
  try {
    const res = await fetch(`${baseUrl(webhook)}/receipts?ids=`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return unreachable;
    const body = await res.json().catch(() => null);
    // A worker deployed before the window existed answers /receipts without a
    // `review` key at all. That is a different fact from a current worker with
    // no date set — one CANNOT close, the other simply is not scheduled to —
    // and reporting both as "open, no window" hid every un-upgraded worker.
    const r = body && body.review;
    return {
      reachable: true,
      gated: !!r,
      state: r && r.state === "closed" ? "closed" : "open",
      open_until: r && typeof r.open_until === "string" ? r.open_until : null,
    };
  } catch {
    return unreachable;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "15 Sep" for display, or null for an absent/unparseable instant. Hand-rolled
 * rather than toLocaleDateString: ICU disagrees with itself across Node builds
 * ("Sep" vs "Sept"), and this string is asserted in tests.
 */
function shortDate(iso) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Is the tyrekick MCP server registered with Claude Code (and does it carry a token)? */
/**
 * Is the agent loop wired up, and under what name. Tries the documented plain
 * `tyrekick` first, then `tyrekick-<project>` — several projects on one machine
 * cannot all be called `tyrekick`, so per-project names are common in practice
 * and a status screen that only knows the one name reports them as missing.
 * Returns the name that answered, so `remove` unregisters what actually exists.
 */
export function mcpNames(project) {
  // Interpolated into a shell command: keep it to characters an MCP server name
  // can hold anyway, so a folder called `foo; rm -rf ~` cannot become an argument.
  const safe = String(project || "").replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  return safe && safe !== "tyrekick" ? ["tyrekick", `tyrekick-${safe}`] : ["tyrekick"];
}

export function mcpStatus(project) {
  const names = mcpNames(project);
  let cliMissing = false;
  for (const name of names) {
    try {
      const out = execSync(`claude mcp get ${name}`, { stdio: ["ignore", "pipe", "ignore"] }).toString();
      return { registered: true, hasToken: /TYREKICK_TOKEN/.test(out), cliMissing: false, name };
    } catch (e) {
      // ENOENT => the `claude` CLI isn't installed; anything else => that name
      // is simply not registered, so try the next one.
      if (e && e.code === "ENOENT") { cliMissing = true; break; }
    }
  }
  return { registered: false, hasToken: false, cliMissing, name: null };
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
  const project = cfg.project || basename(resolve("."));
  // One request, two answers: reachability and the review window. It is the
  // same /receipts URL status has always fetched, so this adds no traffic.
  const review = transport === "json" && cfg.webhook ? await probeWindow(cfg.webhook) : null;
  const worker = review ? review.reachable : null;
  // Self-healing bookmark: picks up projects wired before the registry existed,
  // and projects an agent wired without ever running `init`.
  if (transport === "json" && cfg.webhook) rememberDeployment(cfg.webhook, project);
  const mcp = mcpStatus(project);
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
    review,
    mcp,
    reviewKey,
    rateLimit,
    secrets,
    // What a pasted review link will unfurl to. Read from the same file the
    // widget lives in, so it reflects the page reviewers actually open.
    preview:
      widget.file && existsSync(widget.file)
        ? linkPreview(readFileSync(widget.file, "utf8"))
        : null,
    project,
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
  else if (s.mcp.registered) {
    // Name it when it is not the default, so two projects' servers are tellable apart.
    const as = s.mcp.name && s.mcp.name !== "tyrekick" ? ` as ${s.mcp.name}` : "";
    rows.push(["MCP", (s.mcp.hasToken ? "✔ registered (token set)" : "✔ registered") + as]);
  }
  else rows.push(["MCP", "✗ not registered"]);

  // The paste IS the ask. A bare unfurl reads like a broken link, and reviewers
  // who do not recognise it do not click.
  if (s.preview) {
    const p = s.preview;
    if (!p.usable) {
      rows.push(["Link preview", `✗ shares as a bare URL — no ${p.missing.join(", ")}`]);
    } else if (p.missing.length) {
      rows.push(["Link preview", `⚠ text only — add og:image for a card`]);
    } else {
      rows.push(["Link preview", "✔ title, description and image"]);
    }
  }

  // Public-share posture — only meaningful on the worker (json) transport.
  if (s.transport === "json") {
    // Review window. Omitted when the worker didn't answer — "open" would be a
    // guess, and an unreachable worker is already reported on the Worker row.
    if (s.review && s.review.reachable) {
      const when = shortDate(s.review.open_until);
      rows.push([
        "Review",
        s.review.state === "closed"
          ? `⏸ closed${when ? ` ${when}` : ""} · npx tyrekick reopen`
          : `✔ open${when ? ` · closes ${when}` : ""}`,
      ]);
    }

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
  if (s.reviewKey)
    items.push("shared review is ON — only for a private link, never a public URL");
  if (s.rateLimit && s.rateLimit.found && !s.rateLimit.configured)
    items.push("no rate limiting — add it before sharing publicly");
  if (s.secrets && s.secrets.known && s.secrets.names.has("ANTHROPIC_API_KEY"))
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
          kind: "verification", // lands resolved: it is a pipe check, not feedback

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
  // Body first: a closed review answers 403 with {"ok":false,"error":"review_closed"},
  // and throwing on the status alone would flatten that to "HTTP 403".
  if (transport === "json") {
    const json = await res.json().catch(() => null);
    if (json && json.ok === false) throw new Error(json.error || "worker said ok:false");
  }
  if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
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

export async function cmdStatus({ all = false, open = false } = {}) {
  if (all) return statusAll({ open });
  const s = await gatherStatus();
  console.log(`\n  tyrekick ${VERSION}  ·  ${s.project}\n`);
  for (const [k, v] of renderStatus(s)) console.log(`  ${k.padEnd(13)} ${v}`);
  const note = readinessNote(s);
  if (note) console.log(`\n  ${note}`);
  console.log("");
}

/**
 * Every deployment this CLI has seen, and which are still open. Probed live and
 * in parallel, so 17 workers cost one 4s round trip. The probe is
 * unauthenticated, so it still works for a worker whose token this machine no
 * longer holds. Always exits 0 — this is a dashboard, not a health gate.
 */
async function statusAll({ open = false } = {}) {
  const reg = readRegistry();
  if (!reg.deployments.length) {
    console.log("\n  Nothing registered yet — run `npx tyrekick status` inside a project to add it.\n");
    return;
  }
  const probes = await Promise.all(reg.deployments.map((d) => probeWindow(d.url)));
  // Comment counts need a token; the window probe does not. A deployment this
  // machine has no token for still lists, with "—" for its count.
  const inboxes = await Promise.all(
    reg.deployments.map((d) => probeOpen(d.url, tokenFor(d.project))),
  );
  const nameW = Math.max(...reg.deployments.map((d) => (d.project || "—").length));
  const n = reg.deployments.length;
  console.log(`\n  ${n} deployment${n === 1 ? "" : "s"} · ${REGISTRY_PATH.replace(homedir(), "~")}`);
  reg.deployments.forEach((d, i) => {
    const p = probes[i];
    const when = shortDate(p.open_until);
    const [icon, state] = !p.reachable
      ? ["?", "unreachable"]
      : !p.gated
        ? ["!", "no gate — redeploy"]
        : p.state === "closed"
          ? ["⏸", `closed${when ? ` ${when}` : ""}`]
          : ["✔", when ? `open until ${when}` : "open, no window"];
    const box = inboxes[i];
    const count = box === null ? "—" : box.length ? `${box.length} open` : "clear";
    console.log(
      `  ${icon} ${(d.project || "—").padEnd(nameW)}  ${state.padEnd(20)}  ${count.padEnd(8)}  ${d.url.replace(/^https?:\/\//, "")}`,
    );
    if (open && box && box.length) {
      for (const c of box) {
        const who = c.reviewer_name || "anon";
        const text = String(c.body || "").replace(/\s+/g, " ").slice(0, 88);
        console.log(`      ${String(c.id || "").slice(0, 8)}  ${(c.created_at || "").slice(0, 10)}  ${who}: ${text}`);
      }
    }
  });
  if (inboxes.some((b) => b === null)) {
    console.log(`\n  "—" means no token on this machine for that worker. Set TYREKICK_TOKEN_<project> to read it.`);
  }
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
  const mcp = mcpStatus(project);
  if (mcp.registered) {
    try {
      execSync(`claude mcp remove ${mcp.name}`, { stdio: ["ignore", "ignore", "ignore"] });
      console.log(`✔ unregistered the ${mcp.name} MCP server.`);
    } catch {
      console.log(`⚠ couldn't run \`claude mcp remove ${mcp.name}\` — remove it manually.`);
    }
  } else if (!mcp.cliMissing) {
    console.log("· MCP not registered (nothing to unregister).");
  }

  // 3. Cloud teardown (opt-in, destructive).
  if (!teardown) {
    console.log("\nLocal wiring removed. The worker, its KV store, and all feedback data are left intact.");
    if (existsSync(PROJECT_CONFIG)) {
      console.log(`· kept ${PROJECT_CONFIG} — it points at a worker that is still live.`);
    }
    console.log("To also delete the cloud worker and its data:  npx tyrekick remove --teardown");
    return;
  }
  const torndown = await teardownCloud({ project, yes });
  if (torndown && w.config?.webhook) forgetDeployment(w.config.webhook);
  // The pointer file outlives everything it names unless it goes too — that is
  // how a fully torn-down project keeps looking like a live one.
  if (torndown && existsSync(PROJECT_CONFIG)) {
    unlinkSync(PROJECT_CONFIG);
    console.log(`✔ removed ${PROJECT_CONFIG}.`);
  }
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
    return false;
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
      return false;
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
  return true;
}

// ---------------------------------------------------------------------------
// Review window — close / reopen
// ---------------------------------------------------------------------------
//
// A review link is not one-shot: ship, gather, fix, ship again. Closing stops
// ingest and nothing else — the URL never moves, and the page, the stored
// feedback, read-back, receipts and the shared review all keep working. The
// window is a plain wrangler [vars] entry (readable on purpose, never a
// secret), so changing it means editing the toml and redeploying.

/**
 * The ISO instant `days` from now, or "" for `--never` (no window at all).
 * Returns null for a non-finite `days` so the caller can fail with a usage
 * line rather than writing "Invalid Date" into someone's config. Pure.
 */
export function windowValue(days, now = new Date()) {
  if (days === null) return "";
  if (typeof days !== "number" || !Number.isFinite(days)) return null;
  return new Date(now.getTime() + days * 864e5).toISOString();
}

/**
 * Set TYREKICK_OPEN_UNTIL in wrangler config text. Pure, and idempotent:
 * applying it twice with the same value yields the same string.
 *
 * A new [vars] block is inserted BEFORE the first table, never appended at EOF
 * — the shipped config ends with [[unsafe.bindings]], and a trailing [vars]
 * would swallow any binding block a user appends later.
 */
export function setWindowInToml(toml, value) {
  const line = `TYREKICK_OPEN_UNTIL = "${value}"`;
  const key = /^[ \t]*TYREKICK_OPEN_UNTIL[ \t]*=.*$/m;
  if (key.test(toml)) return toml.replace(key, line);

  const vars = toml.match(/^[ \t]*\[vars\][ \t]*$/m);
  if (vars) {
    const at = vars.index + vars[0].length;
    return `${toml.slice(0, at)}\n${line}${toml.slice(at)}`;
  }

  const table = toml.match(/^[ \t]*\[/m);
  if (table) return `${toml.slice(0, table.index)}[vars]\n${line}\n\n${toml.slice(table.index)}`;

  const head = toml.replace(/\s*$/, "");
  return head ? `${head}\n\n[vars]\n${line}\n` : `[vars]\n${line}\n`;
}

/**
 * `tyrekick close` / `tyrekick reopen`: rewrite one [vars] line and redeploy.
 * No confirmation prompt — closing destroys nothing and is one command to undo.
 */
export async function cmdWindow({ days, verb }) {
  const w = findWidget();
  const cfg = w.config || {};
  if (!cfg.webhook) {
    fail("No tyrekick widget found here — run this from the project whose review you want to close.");
  }
  if ((cfg.transport || "json") !== "json") {
    fail("Discord destinations are write-only — they have no review window.");
  }
  const value = windowValue(days);
  if (value === null) fail("--days must be a number (or use --never).");

  const toml = findWrangler();
  if (!toml) {
    console.log(
      `\n⚠ No wrangler config found here, so I can't redeploy the worker for you.\n` +
        `  From the folder you deployed it in:\n` +
        `    set TYREKICK_OPEN_UNTIL = "${value}" under [vars] in wrangler.toml\n` +
        `    npx wrangler deploy`,
    );
    return;
  }

  writeFileSync(toml, setWindowInToml(readFileSync(toml, "utf8"), value));
  console.log(`✔ TYREKICK_OPEN_UNTIL = "${value}" in ${toml}`);

  try {
    // --config: findWrangler() may return wrangler.local.toml, which wrangler does
    // not discover on its own — a bare deploy would push the OTHER config.
    execSync(`npx wrangler deploy --config ${basename(toml)}`, { stdio: "inherit", cwd: dirname(toml) });
  } catch {
    // Deliberately not rolled back: a half-applied deploy is the user's to inspect.
    console.log("⚠ npx wrangler deploy failed — the config is written; deploy it manually.");
    return;
  }

  if (cfg.webhook) rememberDeployment(cfg.webhook, cfg.project || basename(resolve(".")));
  if (!value) console.log("✔ this endpoint no longer closes on its own.");
  else if (verb === "close") {
    console.log(
      "✔ closed — no new comments. Same URL: the page, the stored feedback and your agent's read-back all still work.",
    );
  } else console.log(`✔ open until ${value}. Same URL — nothing moved.`);
}
