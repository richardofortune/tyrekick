import { test, expect } from "@playwright/test";
import { routeWebhook, DEMO } from "./helpers";

// Mobile viewport 390×844 with touch enabled, regardless of the running project.
test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

test.describe("mobile (390×844)", () => {
  test("tap-to-pin works and the composer is fully visible in-viewport", async ({
    page,
  }) => {
    const hook = await routeWebhook(page);
    await page.goto(DEMO);

    const trigger = page.getByRole("button", { name: "Give feedback" });
    await expect(trigger).toBeVisible();
    await trigger.tap();

    await expect(page.getByText(/click anywhere/i)).toBeVisible();

    // Tap a point to drop a pin.
    await page.touchscreen.tap(195, 420);

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Composer must be fully within the 390×844 viewport (flips to stay visible).
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-0.5);
    expect(box!.y).toBeGreaterThanOrEqual(-0.5);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390 + 0.5);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844 + 0.5);

    // The whole flow is usable via touch.
    await dialog.locator("textarea").fill("mobile feedback works");
    await dialog.getByRole("button", { name: /send|submit/i }).tap();
    await expect(page.getByText(/sent/i)).toBeVisible();

    expect(hook.count()).toBe(1);
    const bodyText: string =
      hook.payloads.at(-1).body ?? hook.payloads.at(-1).content ?? "";
    expect(bodyText).toContain("mobile feedback works");
  });
});
