/**
 * tyrekick — interactive management menu.
 *
 * A zero-dependency, arrow-key terminal menu built on Node's readline raw mode
 * plus ANSI escapes (no ink/blessed — keeps `npx tyrekick` tiny). Renders a
 * live status dashboard and dispatches to the commands in lib.mjs.
 */
import readline from "node:readline";
import {
  VERSION,
  gatherStatus,
  renderStatus,
  cmdDisable,
  cmdEnable,
  cmdRemove,
  sendTest,
  printMcpAdd,
} from "./lib.mjs";

const CLEAR = "\x1b[2J\x1b[H";
const INVERT = "\x1b[7m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

const clear = () => process.stdout.write(CLEAR);

/** Build the action list from the current status (items depend on state). */
function buildItems(s) {
  const items = [];

  if (s.widget.state === "installed" && s.widget.kind === "esm")
    items.push({ label: "Disable widget — how-to (ESM mount)", run: async () => cmdDisable() });
  else if (s.widget.state === "installed")
    items.push({ label: "Disable widget (keep worker + data)", run: async () => cmdDisable() });
  else if (s.widget.state === "disabled")
    items.push({ label: "Enable widget", run: async () => cmdEnable() });
  else
    items.push({
      label: "Install widget — run `npx tyrekick init`",
      run: async () => console.log("Run `npx tyrekick init` to install the widget, then come back here."),
    });

  if (s.transport === "json" && s.cfg.webhook && !s.mcp.registered)
    items.push({ label: "Show MCP setup command", run: async () => printMcpAdd(s.cfg.webhook) });

  if (s.cfg.webhook)
    items.push({
      label: "Send a test comment",
      run: async () => {
        try {
          await sendTest(s.cfg.webhook, s.transport, s.project, s.cfg.appVersion || "v0.1");
          console.log(`✔ test comment sent — check your ${s.transport === "discord" ? "Discord channel" : "worker store"}.`);
        } catch (e) {
          console.log(`⚠ test failed (${e.message}) — check the webhook URL.`);
        }
      },
    });

  items.push({ label: "Remove local wiring (keep data)", run: async () => cmdRemove({ teardown: false }) });
  items.push({
    label: "Remove + tear down cloud (deletes ALL feedback)",
    danger: true,
    run: async () => cmdRemove({ teardown: true }),
  });
  items.push({ label: "Refresh", refresh: true });
  items.push({ label: "Quit", quit: true });
  return items;
}

/** Raw-mode arrow-key picker. Resolves the chosen index, or -1 on quit. */
function pick(s, items) {
  return new Promise((res) => {
    let idx = 0;

    const render = () => {
      const lines = [];
      lines.push(`  ${INVERT} tyrekick ${VERSION} ${RESET}  ·  ${s.project}`);
      lines.push("");
      for (const [k, v] of renderStatus(s)) lines.push(`    ${k.padEnd(7)} ${v}`);
      lines.push("");
      items.forEach((it, i) => {
        const sel = i === idx;
        const label = it.danger ? `\x1b[31m${it.label}${RESET}` : it.label;
        lines.push(sel ? `  ${INVERT} ▸ ${it.label} ${RESET}` : `      ${label}`);
      });
      lines.push("");
      lines.push(`  ${DIM}↑↓/jk move · ↵ select · q quit${RESET}`);
      process.stdout.write(CLEAR + lines.join("\n") + "\n");
    };

    const cleanup = () => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("keypress", onKey);
    };

    const onKey = (_str, key) => {
      if (!key) return;
      if (key.name === "up" || key.name === "k") {
        idx = (idx - 1 + items.length) % items.length;
        render();
      } else if (key.name === "down" || key.name === "j") {
        idx = (idx + 1) % items.length;
        render();
      } else if (key.name === "return" || key.name === "enter") {
        cleanup();
        res(idx);
      } else if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup();
        res(-1);
      }
    };

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKey);
    render();
  });
}

/** Wait for a single keypress before returning to the menu. */
function pause() {
  return new Promise((res) => {
    process.stdout.write(`\n  ${DIM}↵ back to menu${RESET} `);
    const cleanup = () => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("keypress", onKey);
    };
    const onKey = () => {
      cleanup();
      res();
    };
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKey);
  });
}

export async function runMenu() {
  // No TTY (piped/CI): the menu can't work — print status and point at subcommands.
  if (!process.stdin.isTTY) {
    const s = await gatherStatus();
    console.log(`\n  tyrekick ${VERSION}  ·  ${s.project}\n`);
    for (const [k, v] of renderStatus(s)) console.log(`  ${k.padEnd(7)} ${v}`);
    console.log(`\n  (non-interactive terminal — use subcommands: status | disable | enable | remove)`);
    return;
  }

  for (;;) {
    const s = await gatherStatus();
    const items = buildItems(s);
    const choice = await pick(s, items);
    if (choice < 0) break;
    const item = items[choice];
    if (item.quit) break;
    if (item.refresh) continue;
    clear();
    await item.run();
    await pause();
  }
  clear();
  console.log("bye 👋");
}
