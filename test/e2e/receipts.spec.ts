import { test, expect } from "@playwright/test";
import { routeWebhook, collectErrors, DEMO } from "./helpers";

/**
 * The closure loop: a delivered comment survives reload as a receipt, the
 * widget asks the worker's /receipts route what happened to it, and the pin
 * turns green with the agent's resolution note. "Got it" retires the mark.
 */

const WORKER = "https://worker.test/feedback";

/** Answer the widget's receipts poll: everything asked about is resolved. */
async function routeReceipts(page: import("@playwright/test").Page, note: string) {
  await page.route("**/receipts*", (route) => {
    const u = new URL(route.request().url());
    const ids = (u.searchParams.get("ids") || "").split(",").filter(Boolean);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        receipts: ids.map((id) => ({
          id,
          status: "resolved",
          resolved_at: new Date().toISOString(),
          resolution_note: note,
        })),
      }),
    });
  });
}

test.describe("receipts: the pin turns green", () => {
  test("resolved comment shows the note at the pin and Got it retires it", async ({
    page,
  }) => {
    await routeWebhook(page); // POSTs mocked OK (registered first)
    await routeReceipts(page, "Moved the CTA above the fold — deploy v2"); // GETs (wins, registered later)
    const errors = collectErrors(page);

    await page.goto(DEMO + "?webhook=" + encodeURIComponent(WORKER));

    // Leave one comment, delivered successfully.
    await page.getByRole("button", { name: "Give feedback" }).click();
    await page.mouse.click(300, 400);
    const dialog = page.getByRole("dialog", { name: "Leave a comment" });
    await dialog.locator("textarea").fill("The hero CTA is buried");
    await dialog.getByRole("button", { name: /send|submit/i }).click();
    await expect(page.getByText(/sent — thank you/i)).toBeVisible();
    await expect(dialog).toBeHidden({ timeout: 5_000 });
    await page.keyboard.press("Escape");

    // "The agent resolves it overnight" — reviewer returns:
    await page.reload();

    // The pin is back, and the receipts poll turned it green.
    const pin = page.locator(".pin");
    await expect(pin).toHaveCount(1);
    await expect(page.locator(".pin.resolved")).toHaveCount(1);

    // Hovering shows the resolution note right at the pin.
    await pin.hover();
    const tip = page.locator(".tip");
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("Moved the CTA above the fold");

    // The drawer carries the closed state and the note…
    await page.getByRole("button", { name: "View comments" }).click();
    const drawer = page.getByRole("complementary", { name: "Feedback comments" });
    await expect(drawer.getByText("✓ resolved")).toBeVisible();
    await expect(drawer.getByText("Moved the CTA above the fold — deploy v2")).toBeVisible();

    // …and "Got it" retires the mark for good.
    await drawer.getByRole("button", { name: "Dismiss closed comment 1" }).click();
    await expect(drawer.getByText("No comments yet.")).toBeVisible();
    await expect(page.locator(".pin")).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole("button", { name: "View comments" })).toBeHidden();

    expect(errors).toEqual([]);
  });

  test("a destination without the receipts route degrades silently", async ({ page }) => {
    await routeWebhook(page);
    await page.route("**/receipts*", (route) =>
      route.fulfill({ status: 404, contentType: "application/json", body: '{"ok":false}' }),
    );
    const errors = collectErrors(page);

    await page.goto(DEMO + "?webhook=" + encodeURIComponent(WORKER));
    await page.getByRole("button", { name: "Give feedback" }).click();
    await page.mouse.click(300, 400);
    const dialog = page.getByRole("dialog", { name: "Leave a comment" });
    await dialog.locator("textarea").fill("No receipts here");
    await dialog.getByRole("button", { name: /send|submit/i }).click();
    await expect(page.getByText(/sent — thank you/i)).toBeVisible();
    await page.keyboard.press("Escape");

    await page.reload();

    // Restored as a plain sent pin: no green, no red, no console noise.
    await expect(page.locator(".pin")).toHaveCount(1);
    await expect(page.locator(".pin.resolved")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
