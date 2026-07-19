#!/usr/bin/env node
/**
 * tyrekick — feedback loop for AI-built prototypes.
 *
 *   npx tyrekick                    interactive management menu (status, disable, remove…)
 *   npx tyrekick init               wire the widget into a project (≤2 questions)
 *   npx tyrekick init --yes …       non-interactive (for agents/CI)
 *   npx tyrekick status             print a one-shot status dashboard
 *   npx tyrekick disable | enable   remove/restore the widget, keeping all feedback data
 *   npx tyrekick remove [--teardown] safely uninstall (add --teardown to also delete the cloud worker)
 *
 * No dependencies, no telemetry. The heavy lifting lives in ./lib.mjs (shared
 * helpers + management commands) and ./tui.mjs (the interactive menu).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  VERSION,
  CDN,
  fail,
  detectHtml,
  gitSha,
  isDiscord,
  sendTest,
  printMcpAdd,
  cmdStatus,
  cmdDisable,
  cmdEnable,
  cmdRemove,
} from "./lib.mjs";
import { runMenu } from "./tui.mjs";

const HELP = `tyrekick ${VERSION} — feedback loop for AI-built prototypes

Usage:
  npx tyrekick                 Interactive management menu (default)
  npx tyrekick init [options]  Wire the feedback widget into a project
  npx tyrekick status          Show what's installed (widget / worker / MCP)
  npx tyrekick disable         Remove the widget but keep the worker + all data (reversible)
  npx tyrekick enable          Restore a disabled widget
  npx tyrekick remove          Uninstall local wiring (widget tag + MCP registration)
  npx tyrekick remove --teardown   …and also delete the cloud worker + KV + ALL feedback

init options:
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
    else if (a === "--teardown") args.teardown = true;
    else if (a === "--webhook") args.webhook = argv[++i];
    else if (a === "--file") args.file = argv[++i];
    else if (a === "--project") args.project = argv[++i];
    else if (a === "--app-version") args.appVersion = argv[++i];
    else if (a === "--transport") args.transport = argv[++i];
    else args._.push(a);
  }
  return args;
}

async function initCmd(args) {
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
    console.log("\nTo let your coding agent pull feedback back (MCP):");
    printMcpAdd(webhook);
  } else {
    console.log(`\nNote: Discord is the human tier (write-only). For the agent loop, use the\n` +
      `Cloudflare worker destination: github.com/richardofortune/tyrekick/tree/main/destinations/cloudflare`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }

  const cmd = args._[0];
  if (!cmd) return runMenu(); // bare `npx tyrekick` → interactive menu

  switch (cmd) {
    case "init":
      return initCmd(args);
    case "status":
      return cmdStatus();
    case "disable":
      return cmdDisable();
    case "enable":
      return cmdEnable();
    case "remove":
      return cmdRemove({ teardown: !!args.teardown, yes: !!args.yes });
    case "menu":
    case "ui":
      return runMenu();
    case "help":
      console.log(HELP);
      return;
    default:
      fail(`Unknown command "${cmd}". Try: npx tyrekick (menu) — or init | status | disable | enable | remove`);
  }
}

main().catch((e) => fail(e.message));
