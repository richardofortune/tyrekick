import { test, expect } from "@playwright/test";
import { routeWebhook, collectErrors, DEMO } from "./helpers";

test.describe("submission failure & recovery", () => {
  test("webhook 500 twice → retry → failure state with working copy-to-clipboard", async ({
    page,
  }) => {
    // Fail every attempt so the single automatic retry also fails.
    const hook = await routeWebhook(page, { failTimes: 99 });
    const errors = collectErrors(page);

    await page.goto(DEMO);
    await page.getByRole("button", { name: "Give feedback" }).click();
    await page.mouse.click(240, 340);

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const comment = "Something is misaligned in the header";
    await dialog.locator("textarea").fill(comment);
    await dialog.getByRole("button", { name: /send|submit/i }).click();

    // Failure surface (allow time for the 2s backoff + retry).
    await expect(
      page.getByText(/couldn't send|copy your comment/i),
    ).toBeVisible({ timeout: 20_000 });

    // A retry actually happened: original attempt + 1 retry = 2 POSTs.
    expect(hook.count()).toBeGreaterThanOrEqual(2);

    // Copy-to-clipboard works.
    await page.getByRole("button", { name: /copy/i }).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain(comment);

    // Even on failure, no console errors / unhandled rejections (contract).
    expect(errors).toEqual([]);
  });

  test("recovers to a working state after a failure (draft text preserved)", async ({
    page,
  }) => {
    await routeWebhook(page, { failTimes: 99 });
    await page.goto(DEMO);
    await page.getByRole("button", { name: "Give feedback" }).click();
    await page.mouse.click(200, 300);
    const dialog = page.getByRole("dialog");
    const comment = "draft that must survive a failed send";
    await dialog.locator("textarea").fill(comment);
    await dialog.getByRole("button", { name: /send|submit/i }).click();

    await expect(page.getByText(/couldn't send|copy your comment/i)).toBeVisible({
      timeout: 20_000,
    });
    // The user's text is still available to copy (not lost).
    await expect(dialog.locator("textarea")).toHaveValue(comment);
  });
});
