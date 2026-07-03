import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { readFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

const TARGETS = ["chrome109", "firefox115", "safari15", "edge109"];

// IIFE bundle for <script> / CDN use. Exposes global `Tyrekick` and
// auto-initialises from data-* attributes on its own <script> tag.
await build({
  entryPoints: ["src/auto.ts"],
  bundle: true,
  format: "iife",
  globalName: "Tyrekick",
  target: TARGETS,
  outfile: "dist/tyrekick.js",
  minify: true,
  legalComments: "none",
});

// ESM bundle for `import { init } from "tyrekick"`.
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  target: TARGETS,
  outfile: "dist/tyrekick.esm.js",
  minify: true,
  legalComments: "none",
});

const gz = gzipSync(readFileSync("dist/tyrekick.js")).length;
console.log(`built dist/tyrekick.js  (${gz} bytes gzipped, ${(gz / 1024).toFixed(1)} KB)`);
console.log(`built dist/tyrekick.esm.js`);
if (gz > 30720) {
  console.error(`FAIL: tyrekick.js is ${gz} bytes gzipped, over the 30720 budget`);
  process.exit(1);
}
