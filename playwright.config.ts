import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config for Tyrekick.
 *
 * Serves the repository root with a plain static server and drives the demo at
 * /demo/index.html. The demo is built by another agent against the same
 * contract; specs locate everything by contract-defined accessible roles/text,
 * and Playwright pierces the widget's open shadow root automatically.
 *
 * The webhook is route-mocked per test (see test/e2e/helpers.ts) so nothing
 * leaves the machine.
 */
const PORT = 8080;
const BASE = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: BASE,
    trace: "on-first-retry",
    permissions: ["clipboard-read", "clipboard-write"],
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Static file server over the repo root; python3 is available on macOS/CI.
    command: `python3 -m http.server ${PORT}`,
    url: `${BASE}/demo/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
