#!/usr/bin/env node
/**
 * Strip local-tooling blocks from docs that ship to other people.
 *
 * Some dev tools (vexp today, others tomorrow) auto-append a block of
 * machine-specific instructions to a project's agent docs. That is fine
 * locally and wrong in a public repo and an npm tarball: it tells every
 * consumer to use an indexing daemon they do not have.
 *
 * `npm run check:clean` FAILS the publish when it finds one. This is the
 * remedy that check points at:
 *
 *   npm run clean:vexp
 *
 * It removes only clearly delimited blocks — HTML comment fences the tool
 * writes itself, e.g.
 *
 *   ## vexp <!-- vexp v2.2.3 -->
 *   …
 *   <!-- /vexp -->
 *
 * Anything not fenced is left alone and reported, because a prose mention of
 * the tool is a human decision to make, not a script's.
 *
 * Exit codes: 0 = clean (with or without edits), 1 = something is left that
 * needs a human. Safe to re-run.
 */
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Docs that reach other people. Keep in step with `check:clean`. */
const TARGETS = [
  "AGENTS.md",
  "README.md",
  "llms.txt",
  "docs",
  "mcp/README.md",
  "destinations",
];

/** Tools known to append fenced blocks. Add a name to cover a new one. */
const TOOLS = ["vexp"];

/** Expand directories to the markdown/text files inside them. */
function expand(target) {
  if (!existsSync(target)) return [];
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target, { withFileTypes: true }).flatMap((e) =>
    expand(join(target, e.name)),
  );
}

/**
 * Remove `<!-- tool … -->` … `<!-- /tool -->` blocks, including any markdown
 * heading immediately preceding the opening fence on the same line.
 */
function stripFenced(text, tool) {
  const pattern = new RegExp(
    // optional leading heading on the fence's own line, then the fenced body
    String.raw`\n*^.*<!--\s*${tool}\b[^>]*-->[\s\S]*?<!--\s*/${tool}\s*-->\s*`,
    "gmi",
  );
  return text.replace(pattern, "\n");
}

const files = TARGETS.flatMap(expand).filter((f) => /\.(md|txt)$/i.test(f));
let changed = 0;
const leftovers = [];

for (const file of files) {
  const before = readFileSync(file, "utf8");
  let after = before;
  for (const tool of TOOLS) after = stripFenced(after, tool);
  if (after !== before) {
    writeFileSync(file, after.replace(/\n{3,}$/, "\n"));
    console.log(`stripped local-tooling block: ${file}`);
    changed += 1;
  }
  // Whatever survived the fenced strip needs eyes, not a regex.
  for (const tool of TOOLS) {
    if (new RegExp(tool, "i").test(after)) leftovers.push(`${file} (mentions "${tool}")`);
  }
}

if (changed === 0 && leftovers.length === 0) {
  console.log("clean: no local-tooling blocks in shared docs");
}
if (leftovers.length) {
  console.error(
    "\nUnfenced mentions remain — remove these by hand (a script shouldn't\n" +
      "guess whether prose is deliberate):\n  " +
      leftovers.join("\n  "),
  );
  process.exit(1);
}
