import { describe, expect, it } from "vitest";
import { validateEnv } from "../src/env.js";

describe("validateEnv", () => {
  it("accepts both vars and strips trailing slashes from the URL", () => {
    const result = validateEnv({
      TYREKICK_URL: "https://tyrekick.test.workers.dev/",
      TYREKICK_TOKEN: "sekret",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.url).toBe("https://tyrekick.test.workers.dev");
      expect(result.env.token).toBe("sekret");
    }
  });

  it("fails with both names when both are missing", () => {
    const result = validateEnv({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("TYREKICK_URL");
      expect(result.error).toContain("TYREKICK_TOKEN");
      expect(result.error).toContain("missing required environment variable(s)");
    }
  });

  it("fails when TYREKICK_URL is missing", () => {
    const result = validateEnv({ TYREKICK_TOKEN: "t" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("TYREKICK_URL");
      expect(result.error).not.toMatch(/variable\(s\): .*TYREKICK_TOKEN/);
    }
  });

  it("fails when TYREKICK_TOKEN is missing", () => {
    const result = validateEnv({ TYREKICK_URL: "https://x.dev" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("TYREKICK_TOKEN");
  });

  it("treats empty / whitespace-only values as missing", () => {
    const result = validateEnv({ TYREKICK_URL: "  ", TYREKICK_TOKEN: "" });
    expect(result.ok).toBe(false);
  });

  it("mentions the wrangler secret command so the fix is actionable", () => {
    const result = validateEnv({});
    if (!result.ok) expect(result.error).toContain("wrangler secret put TYREKICK_TOKEN");
  });
});
