import { test, expect } from "@playwright/test";
import { routeWebhook, collectErrors, DEMO } from "./helpers";

test.describe("clean-composer re-pin", () => {
  test("clicking elsewhere while the composer is untouched moves the pin there", async ({
    page,
  }) => {
    await routeWebhook(page);
    const errors = collectErrors(page);

    await page.goto(DEMO);
    await page.getByRole("button", { name: "Give feedback" }).click();
    await page.mouse.click(200, 300);
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator(".pin")).toHaveCount(1);

    // Untouched composer: a click elsewhere abandons pin 1 and re-pins there.
    await page.mouse.click(650, 400);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const pin = page.locator(".pin");
    await expect(pin).toHaveCount(1);
    await expect(pin).toContainText("1"); // renumbered, not stacked

    const box = await pin.boundingBox();
    expect(box).toBeTruthy();
    // Pin element is 24px with a -12px margin, so its centre is the click point.
    expect(Math.abs(box!.x + box!.width / 2 - 650)).toBeLessThanOrEqual(2);
    expect(Math.abs(box!.y + box!.height / 2 - 400)).toBeLessThanOrEqual(2);

    expect(errors).toEqual([]);
  });

  test("a composer with typed content is protected from click-away", async ({
    page,
  }) => {
    await routeWebhook(page);
    await page.goto(DEMO);
    await page.getByRole("button", { name: "Give feedback" }).click();
    await page.mouse.click(200, 300);

    const dialog = page.getByRole("dialog");
    await dialog.locator("textarea").fill("keep me");

    // Dirty composer: clicking elsewhere neither closes it nor adds a pin.
    await page.mouse.click(650, 400);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("textarea")).toHaveValue("keep me");
    await expect(page.locator(".pin")).toHaveCount(1);
  });
});
