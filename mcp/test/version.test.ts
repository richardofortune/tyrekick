import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The version lives in two files that npm cannot keep in step for us:
 * package.json (what gets published) and server.json (what the MCP registries
 * read). serverInfo used to be a third, hardcoded, and it drifted to 0.1.0 for
 * three releases before anyone noticed — it now reads package.json, so this
 * only has to guard the pair that is still hand-edited.
 */
const read = (f: string) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));

describe("version", () => {
  it("is the same in package.json and both server.json fields", () => {
    const { version } = read("package.json");
    const manifest = read("server.json");
    expect(manifest.version).toBe(version);
    expect(manifest.packages[0].version).toBe(version);
  });
});
