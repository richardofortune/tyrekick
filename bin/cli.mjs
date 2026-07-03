#!/usr/bin/env node
/**
 * tyrekick init — wire the feedback widget into a project in one command.
 *
 *   npx tyrekick init                         interactive (≤2 questions)
 *   npx tyrekick init --webhook <url> --yes   non-interactive (for agents)
 *
 * What it does: finds your HTML entry file, injects the CDN script tag
 * (project name from the folder, app version from the git SHA), optionally
 * sends a test comment, and prints the `claude mcp add` command for the
 * agent loop. No dependencies, no telemetry.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const VERSION = "0.2.0";
const CDN = `https://cdn.jsdelivr.net/npm/tyrekick@0.2/dist/tyrekick.js`;

const HELP = `tyrekick ${VERSION} — feedback loop for AI-built prototypes

Usage: npx tyrekick init [options]

Options:
  --webhook <url>      Destination URL (Discord webhook or Tyrekick worker). Prompted if omitted.
  --file <path>        HTML file to inject into (default: auto-detect index.html)
  --project <name>     Project label (default: current folder name)
  --app-version <v>    Version string (default: git short SHA, else "v0.1")
  --transport <t>      "discord" | "json" (default: auto-detect from URL)
  --no-test            Skip sending the test comment
  --yes                No prompts; fail instead of asking (for agents/CI)
  --help               Show this help

Docs: https://github.com/richardofortune/tyrekick`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--yes" || a === "-y") args.yes = true;
    else if (a === "--no-test") args.noTest = true;
    else if (a === "--webhook") args.webhook = argv[++i];
    else if (a === "--file") args.file = argv[++i];
    else if (a === "--project") args.project = argv[++i];
    else if (a === "--app-version") args.appVersion = argv[++i];
    else if (a === "--transport") args.transport = argv[++i];
    else args._.push(a);
  }
  return args;
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function detectHtml(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) fail(`--file ${explicit} does not exist`);
    return explicit;
  }
  const candidates = ["index.html", "public/index.html", "dist/index.html", "src/index.html"];
  const found = candidates.filter((c) => existsSync(c));
  if (found.length === 0) {
    fail("No index.html found (looked in ., public/, dist/, src/). Point me at one with --file <path>.");
  }
  return found[0];
}

function gitSha() {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function isDiscord(url) {
  return /discord(app)?\.com\/api\/webhooks\//.test(url);
}

async function sendTest(webhook, transport, project, appVersion) {
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
          body: "Test comment from `tyrekick init` — the widget is wired up.",
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._[0] === "help") { console.log(HELP); return; }
  if (args._[0] && args._[0] !== "init") fail(`Unknown command "${args._[0]}". Try: npx tyrekick init`);

  const rl = args.yes ? null : createInterface({ input: process.stdin, output: process.stdout });

  // 1. Destination
  let webhook = args.webhook;
  if (!webhook) {
    if (args.yes) fail("--webhook is required with --yes");
    console.log("Where should feedback go?");
    console.log("  · Discord: Server Settings → Integrations → Webhooks → New Webhook → Copy URL");
    console.log("  · Or a deployed Tyrekick worker URL (…workers.dev/feedback)");
    webhook = (await rl.question("Webhook URL: ")).trim();
    if (!webhook) { rl.close(); fail("A webhook URL is required."); }
  }
  if (!/^https?:\/\//.test(webhook)) { rl?.close(); fail("Webhook must be an http(s) URL."); }

  // 2. Everything else is detected
  const transport = args.transport || (isDiscord(webhook) ? "discord" : "json");
  const file = detectHtml(args.file);
  const project = args.project || basename(resolve("."));
  const appVersion = args.appVersion || gitSha() || "v0.1";

  // 3. Inject (idempotent)
  const html = readFileSync(file, "utf8");
  if (/data-webhook=|tyrekick(\.js|@)/i.test(html)) {
    console.log(`✓ ${file} already has a Tyrekick script tag — leaving it as is.`);
  } else {
    const tag =
      `  <!-- Tyrekick: reviewers pin feedback; agents pull it back (github.com/richardofortune/tyrekick) -->\n` +
      `  <script src="${CDN}"\n` +
      `          data-webhook="${webhook}"\n` +
      (transport === "discord" ? `          data-transport="discord"\n` : "") +
      `          data-project-name="${project}"\n` +
      `          data-app-version="${appVersion}"></script>\n`;
    const updated = html.includes("</body>")
      ? html.replace("</body>", `${tag}</body>`)
      : html + "\n" + tag;
    writeFileSync(file, updated);
    console.log(`✓ injected widget into ${file} (project: ${project}, version: ${appVersion}, transport: ${transport})`);
  }

  // 4. Test comment
  let doTest = !args.noTest;
  if (doTest && rl) {
    const a = (await rl.question("Send a test comment to verify the destination? [Y/n] ")).trim().toLowerCase();
    doTest = a === "" || a === "y" || a === "yes";
  }
  if (doTest) {
    try {
      await sendTest(webhook, transport, project, appVersion);
      console.log(`✓ test comment sent — check your ${transport === "discord" ? "Discord channel" : "worker store"}`);
    } catch (e) {
      console.log(`⚠ test comment failed (${e.message}) — the tag is installed; check the webhook URL.`);
    }
  }
  rl?.close();

  // 5. Agent loop pointer (worker destinations only)
  if (transport === "json") {
    const base = webhook.replace(/\/feedback\/?$/, "");
    console.log(`\nTo let your coding agent pull feedback back (MCP):\n` +
      `  claude mcp add tyrekick \\\n` +
      `    --env TYREKICK_URL=${base} \\\n` +
      `    --env TYREKICK_TOKEN=<your token> \\\n` +
      `    -- npx tyrekick-mcp\n` +
      `Then: "list the open feedback and fix what people flagged".`);
  } else {
    console.log(`\nNote: Discord is the human tier (write-only). For the agent loop, use the\n` +
      `Cloudflare worker destination: github.com/richardofortune/tyrekick/tree/main/destinations/cloudflare`);
  }
}

main().catch((e) => fail(e.message));
