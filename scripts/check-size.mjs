#!/usr/bin/env node
/**
 * Size gate for dist/tyrekick.js, and a check that the README still tells the
 * truth about it.
 *
 * Two failures this prevents:
 *   1. Quietly outgrowing the 30 KB budget the widget promises.
 *   2. Quietly outgrowing the "~13 KB" the README claims — the number in the
 *      badge and the intro is a promise to anyone deciding whether to add this
 *      to their page, and it drifted from 12 to 14 KB without anyone noticing.
 *
 * Run `node build.mjs` first (npm run size does).
 */
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const BUDGET = 30 * 1024;

const bytes = gzipSync(readFileSync("dist/tyrekick.js")).length;
const kb = bytes / 1024;
console.log(`tyrekick.js gzipped: ${bytes} bytes (${kb.toFixed(1)} KB)`);

let failed = false;

if (bytes > BUDGET) {
  console.error(`FAIL: exceeds the ${BUDGET} byte budget`);
  failed = true;
} else {
  console.log(`OK: within the ${(BUDGET / 1024).toFixed(0)} KB budget`);
}

// Every "~N KB" the README claims must round to the real figure. Claims are
// deliberately fuzzy ("~14 KB"), so allow the honest rounding window and
// nothing more.
//
// The separator matches a literal space OR "%20": the shields.io badge URL is
// URL-encoded (`gzip-~14%20KB`), and it is the most visible claim on the page —
// an earlier version of this check missed it for exactly that reason.
const readme = readFileSync("README.md", "utf8");
const claims = [...readme.matchAll(/~(\d+)(?:\s|%20)*KB/gi)].map((m) => Number(m[1]));
const stale = [...new Set(claims)].filter((c) => Math.abs(c - kb) >= 1);

if (stale.length) {
  console.error(
    `FAIL: README claims ~${stale.join(" KB, ~")} KB but the widget is ${kb.toFixed(1)} KB.\n` +
      `      Update the badge and the intro line in README.md.`,
  );
  failed = true;
} else if (claims.length) {
  console.log(`OK: README's ~${[...new Set(claims)].join("/")} KB claim matches`);
}

process.exit(failed ? 1 : 0);
