import { test, expect } from "@playwright/test";
import { routeWebhook, collectErrors, DEMO } from "./helpers";

/**
 * Shared review: with a review key, the widget pulls every reviewer's pins from
 * the worker's /shared view and renders them read-only alongside your own.
 */

const WORKER = "https://worker.test/feedback";
const KEY = "rk-e2e-secret";
const OTHER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function url(extra = "") {
  return DEMO + "?webhook=" + encodeURIComponent(WORKER) + "&reviewKey=" + KEY + extra;
}

/** Serve one foreign pin from /shared, capturing what the widget asked for. */
async function routeShared(
  page: import("@playwright/test").Page,
  pins: unknown[],
  seen?: { headers: Record<string, string>; url: string }[],
) {
  await page.route("**/shared*", (route) => {
    if (seen) {
      seen.push({ headers: route.request().headers(), url: route.request().url() });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, count: pins.length, total: pins.length, pins }),
    });
  });
}

const foreignPin = (over: Record<string, unknown> = {}) => ({
  id: OTHER_ID,
  created_at: "2026-07-20T09:00:00.000Z",
  app_version: "prototype-0.1",
  route: "/demo/index.html",
  body: "This date picker is confusing",
  reviewer_name: "Dana",
  status: "open",
  resolved_at: null,
  resolution_note: null,
  anchor: {
    x_pct: 30,
    y_pct: 20,
    selector: null,
    viewport: { w: 1280, h: 720 },
    element: null,
    context: { heading: null, landmark: null },
  },
  ...over,
});

test.describe("shared review", () => {
  test("another reviewer's comment renders as an attributed read-only pin", async ({
    page,
  }) => {
    const seen: { headers: Record<string, string>; url: string }[] = [];
    await routeWebhook(page);
    await routeShared(page, [foreignPin()], seen);
    const errors = collectErrors(page);

    await page.goto(url());

    // The foreign pin appears without the reviewer doing anything.
    const foreign = page.locator(".pin.foreign");
    await expect(foreign).toHaveCount(1);
    await expect(foreign).toHaveAttribute("aria-label", /by Dana/);

    // The key went in the header, the project/route in the query string.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].headers["x-tyrekick-review-key"]).toBe(KEY);
    expect(seen[0].url).toContain("project=Wander%20Trip%20Planner");
    // Scoped by pathname, so the page's own query string (here: the demo
    // harness's ?webhook=&reviewKey=) never travels to the worker.
    expect(seen[0].url).toContain("route=%2Fdemo%2Findex.html");
    expect(seen[0].url).not.toContain("webhook%3D");

    // Hovering attributes it; the drawer lists it with no destructive actions.
    await foreign.hover();
    await expect(page.locator(".tip")).toContainText("Dana: This date picker is confusing");

    await page.getByRole("button", { name: "View comments" }).click();
    const drawer = page.getByRole("complementary", { name: "Feedback comments" });
    await expect(drawer.locator(".entry.foreign")).toHaveCount(1);
    await expect(drawer.getByText("This date picker is confusing")).toBeVisible();
    await expect(drawer.getByRole("button", { name: /^Discard/ })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: /^Retry/ })).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test("your own comment is not duplicated when it returns in the shared view", async ({
    page,
  }) => {
    let posted: string | null = null;
    await page.route("**/feedback*", async (route) => {
      const body = route.request().postDataJSON() as { id: string };
      posted = body.id;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: '{"ok":true}',
      });
    });
    // The shared view echoes back whatever we posted, as a real worker would.
    await page.route("**/shared*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          pins: posted ? [foreignPin({ id: posted, body: "Mine", reviewer_name: null })] : [],
        }),
      }),
    );
    const errors = collectErrors(page);

    await page.goto(url());
    await page.getByRole("button", { name: "Give feedback" }).click();
    await page.mouse.click(300, 400);
    const dialog = page.getByRole("dialog", { name: "Leave a comment" });
    await dialog.locator("textarea").fill("Mine");
    await dialog.getByRole("button", { name: /send|submit/i }).click();
    await expect(page.getByText(/sent — thank you/i)).toBeVisible();
    await page.keyboard.press("Escape");

    await page.reload();

    // Exactly one pin — ours — not a foreign copy of ourselves next to it.
    await expect(page.locator(".pin")).toHaveCount(1);
    await expect(page.locator(".pin.foreign")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("no review key means no /shared request at all", async ({ page }) => {
    let called = 0;
    await routeWebhook(page);
    await page.route("**/shared*", (route) => {
      called += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"pins":[]}' });
    });
    const errors = collectErrors(page);

    await page.goto(DEMO + "?webhook=" + encodeURIComponent(WORKER));
    await expect(page.getByRole("button", { name: "Give feedback" })).toBeVisible();
    await page.waitForTimeout(300);

    expect(called).toBe(0);
    expect(errors).toEqual([]);
  });

  test("a destination without the shared route degrades silently", async ({ page }) => {
    await routeWebhook(page);
    await page.route("**/shared*", (route) =>
      route.fulfill({ status: 404, contentType: "application/json", body: '{"ok":false}' }),
    );
    const errors = collectErrors(page);

    await page.goto(url());
    await page.waitForTimeout(300);

    await expect(page.locator(".pin.foreign")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
