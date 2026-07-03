import { defineConfig } from "vitest/config";

/**
 * Unit test config for Tyrekick.
 * Runs the jsdom unit suite under test/unit/. The Playwright e2e specs under
 * test/e2e/ are intentionally excluded (they run via `playwright test`).
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/unit/**/*.test.ts"],
    exclude: ["test/e2e/**", "node_modules/**", "dist/**"],
    globals: true,
    clearMocks: true,
    restoreMocks: true,
  },
});
