import { test, expect } from "@playwright/test";
import { routeWebhook, collectErrors, DEMO } from "./helpers";

async function submitComment(page: import("@playwright/test").Page, x: number, y: number, text: string) {
  await page.getByRole("button", { name: "Give feedback" }).click();
  await page.mouse.click(x, y);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator("textarea").fill(text);
  await dialog.getByRole("button", { name: /send|submit/i }).click();
  await expect(page.getByText(/sent — thank you/i)).toBeVisible();
  await expect(dialog).toBeHidden({ timeout: 5_000 }); // 1.5s auto-close
  // leave comment mode so the next call starts from the idle state
  await page.keyboard.press("Escape");
}

test.describe("comment drawer", () => {
  test("toggle appears after a comment; drawer lists text and locates the pin", async ({
    page,
  }) => {
    await routeWebhook(page);
    const errors = collectErrors(page);
    await page.goto(DEMO);

    // No comments yet → no toggle.
    const toggle = page.getByRole("button", { name: "View comments" });
    await expect(toggle).toBeHidden();

    await submitComment(page, 240, 340, "The header copy feels off");
    await submitComment(page, 300, 420, "Make this button bigger");

    // Toggle now visible with the count.
    await expect(toggle).toBeVisible();

    await toggle.click();
    const drawer = page.getByRole("complementary", { name: "Feedback comments" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("Comments (2)")).toBeVisible();
    await expect(drawer.getByText("The header copy feels off")).toBeVisible();
    await expect(drawer.getByText("Make this button bigger")).toBeVisible();

    // Clicking an entry pulses the matching pin (pins are shown while open).
    await drawer.getByRole("button", { name: "Go to comment 1" }).click();
    const host = page.locator("[data-tyrekick]");
    await expect(host.locator(".pin.pulse")).toHaveCount(1);

    // Esc closes the drawer and returns focus to the toggle.
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(toggle).toBeFocused();

    expect(errors).toEqual([]);
  });

  test("submitted comments do not survive reload via localStorage", async ({ page }) => {
    await routeWebhook(page);
    await page.goto(DEMO);
    await submitComment(page, 260, 360, "Persisted note about the hero");

    await page.reload();
    await routeWebhook(page);

    const toggle = page.getByRole("button", { name: "View comments" });
    await expect(toggle).toBeHidden();
  });
});
