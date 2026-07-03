import { test, expect } from "@playwright/test";
import { routeWebhook, DEMO } from "./helpers";

test.describe("keyboard: Esc & focus trap", () => {
  test("Esc closes composer, second Esc exits comment mode, focus returns to trigger", async ({
    page,
  }) => {
    await routeWebhook(page);
    await page.goto(DEMO);

    const trigger = page.getByRole("button", { name: "Give feedback" });
    await trigger.click();
    await expect(page.getByText(/click anywhere/i)).toBeVisible();

    await page.mouse.click(220, 300);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // First Esc: composer closes, still in comment mode.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/click anywhere/i)).toBeVisible();

    // Second Esc: exits comment mode entirely.
    await page.keyboard.press("Escape");
    await expect(page.getByText(/click anywhere/i)).toBeHidden();

    // Focus returns to the trigger.
    await expect(trigger).toBeFocused();
  });

  test("focus is trapped inside the composer dialog", async ({ page }) => {
    await routeWebhook(page);
    await page.goto(DEMO);

    await page.getByRole("button", { name: "Give feedback" }).click();
    await page.mouse.click(220, 300);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Tab several times; the active element must stay within the dialog.
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      const inside = await dialog.evaluate((d) => {
        const root = d.getRootNode() as Document | ShadowRoot;
        const active = (root as ShadowRoot).activeElement ?? document.activeElement;
        return !!active && d.contains(active);
      });
      expect(inside).toBe(true);
    }

    // Shift+Tab as well.
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Shift+Tab");
      const inside = await dialog.evaluate((d) => {
        const root = d.getRootNode() as Document | ShadowRoot;
        const active = (root as ShadowRoot).activeElement ?? document.activeElement;
        return !!active && d.contains(active);
      });
      expect(inside).toBe(true);
    }
  });

  test("trigger is keyboard operable (Enter activates comment mode)", async ({
    page,
  }) => {
    await routeWebhook(page);
    await page.goto(DEMO);
    const trigger = page.getByRole("button", { name: "Give feedback" });
    await trigger.focus();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText(/click anywhere/i)).toBeVisible();
  });
});
