import { test, expect } from "@playwright/test";
import { routeWebhook, collectErrors, DEMO } from "./helpers";

/**
 * Pins as first-class objects: persistent presence, hover tooltip, click-to-
 * thread popover, reply-in-place highlight, and the drawer's hide-pins toggle.
 */

async function submitOne(page: import("@playwright/test").Page, x: number, y: number, text: string) {
  await page.getByRole("button", { name: "Give feedback" }).click();
  await page.mouse.click(x, y);
  const dialog = page.getByRole("dialog", { name: "Leave a comment" });
  await expect(dialog).toBeVisible();
  await dialog.locator("textarea").fill(text);
  await dialog.getByRole("button", { name: /send|submit/i }).click();
  await expect(page.getByText(/sent — thank you/i)).toBeVisible();
  await expect(dialog).toBeHidden({ timeout: 5_000 });
  await page.keyboard.press("Escape"); // leave comment mode
}

test.describe("interactive pins", () => {
  test("pins stay on the page after leaving comment mode", async ({ page }) => {
    await routeWebhook(page);
    const errors = collectErrors(page);
    await page.goto(DEMO);
    await submitOne(page, 240, 340, "The hero copy is unclear");

    // Comment mode is over, no drawer open — the mark is still there, dimmed.
    await expect(page.getByText(/click anywhere/i)).toBeHidden();
    const pin = page.locator(".pin");
    await expect(pin).toBeVisible();
    await expect(page.locator("[data-tyrekick]")).not.toHaveClass(/tk-engaged/);

    expect(errors).toEqual([]);
  });

  test("hovering a pin shows the comment text", async ({ page }) => {
    await routeWebhook(page);
    await page.goto(DEMO);
    await submitOne(page, 240, 340, "Contrast is too low here");

    await page.locator(".pin").hover();
    const tip = page.locator(".tip");
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("Contrast is too low here");

    await page.mouse.move(600, 600); // leave — tooltip goes away
    await expect(tip).toBeHidden();
  });

  test("clicking a pin opens its thread popover with actions", async ({ page }) => {
    await routeWebhook(page);
    const errors = collectErrors(page);
    await page.goto(DEMO);
    await submitOne(page, 240, 340, "The hero copy is unclear");

    await page.locator(".pin").click();
    const thread = page.getByRole("dialog", { name: "Comment 1 thread" });
    await expect(thread).toBeVisible();
    await expect(thread.getByText("The hero copy is unclear")).toBeVisible();

    // Follow up from the pin: reply composer opens, root pin gets the ring.
    await thread.getByRole("button", { name: "Add follow-up to comment 1" }).click();
    await expect(thread).toBeHidden();
    const dialog = page.getByRole("dialog", { name: "Leave a comment" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Replying to #1")).toBeVisible();
    await expect(page.locator(".pin.ring")).toHaveCount(1);

    // Cancel: ring comes off, pin remains.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator(".pin.ring")).toHaveCount(0);
    await expect(page.locator(".pin")).toHaveCount(1);

    expect(errors).toEqual([]);
  });

  test("Esc and outside clicks dismiss the thread popover", async ({ page }) => {
    await routeWebhook(page);
    await page.goto(DEMO);
    await submitOne(page, 240, 340, "First note");

    await page.locator(".pin").click();
    const thread = page.getByRole("dialog", { name: "Comment 1 thread" });
    await expect(thread).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(thread).toBeHidden();

    await page.locator(".pin").click();
    await expect(thread).toBeVisible();
    await page.mouse.click(700, 600); // outside
    await expect(thread).toBeHidden();
  });

  test("drawer's Hide pins toggle suppresses and restores the markers", async ({ page }) => {
    await routeWebhook(page);
    await page.goto(DEMO);
    await submitOne(page, 240, 340, "Note to hide");

    await page.getByRole("button", { name: "View comments" }).click();
    const drawer = page.getByRole("complementary", { name: "Feedback comments" });
    await expect(drawer).toBeVisible();

    await drawer.getByRole("button", { name: "Hide pins" }).click();
    await expect(page.locator(".pin")).toBeHidden();

    await drawer.getByRole("button", { name: "Show pins" }).click();
    await expect(page.locator(".pin")).toBeVisible();
  });
});
