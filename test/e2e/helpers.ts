import type { Page, Route } from "@playwright/test";

export interface WebhookMock {
  /** Parsed JSON bodies (or raw strings) of every intercepted POST. */
  payloads: any[];
  /** Number of POST attempts observed (useful for asserting retries). */
  count(): number;
}

/**
 * Intercept the feedback webhook. Every POST (regardless of URL / origin) is
 * captured and answered locally; GET requests (the demo's own assets) pass
 * through untouched.
 *
 * Options:
 *  - failTimes: return HTTP 500 (+ `{"ok":false}`) for the first N attempts.
 *  - status:    status for successful attempts (default 200; use 204 for discord).
 */
export async function routeWebhook(
  page: Page,
  opts: { failTimes?: number; status?: number } = {},
): Promise<WebhookMock> {
  const payloads: any[] = [];
  let attempts = 0;
  const failTimes = opts.failTimes ?? 0;
  const okStatus = opts.status ?? 200;

  await page.route("**/*", async (route: Route) => {
    const req = route.request();
    if (req.method() !== "POST") {
      return route.continue();
    }
    attempts += 1;
    let data: any = null;
    try {
      data = req.postDataJSON();
    } catch {
      data = req.postData();
    }
    payloads.push(data);

    if (attempts <= failTimes) {
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false }),
      });
    }
    return route.fulfill({
      status: okStatus,
      contentType: "application/json",
      body: okStatus === 204 ? "" : JSON.stringify({ ok: true }),
    });
  });

  return { payloads, count: () => attempts };
}

/** Attach listeners that record page errors / console errors for clean-flow assertions. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    // Chromium logs "Failed to load resource: ... 500" itself whenever a fetch
    // gets a non-2xx response; that's a browser network log, not an error the
    // library raised, and it can't be suppressed from JS. The contract's
    // "no console errors" covers library-generated errors/rejections only.
    if (msg.type() === "error" && !/Failed to load resource/i.test(msg.text())) {
      errors.push(`console.error: ${msg.text()}`);
    }
  });
  return errors;
}

export const DEMO = "/demo/index.html";
