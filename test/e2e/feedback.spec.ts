import { test, expect } from "@playwright/test";
import { routeWebhook, collectErrors, DEMO } from "./helpers";

test.describe("feedback happy path", () => {
  test("trigger → comment mode → click → compose → submit → success", async ({
    page,
  }) => {
    const hook = await routeWebhook(page);
    const errors = collectErrors(page);

    await page.goto(DEMO);

    // Trigger is visible & accessible.
    const trigger = page.getByRole("button", { name: "Give feedback" });
    await expect(trigger).toBeVisible();

    // Enter comment mode → crosshair hint bar.
    await trigger.click();
    await expect(page.getByText(/click anywhere/i)).toBeVisible();

    // Click a point on the page.
    const point = { x: 220, y: 320 };
    await page.mouse.click(point.x, point.y);

    // Composer opens as a dialog.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Type a comment and submit.
    const commentText = "The primary button contrast looks a bit low here";
    await dialog.locator("textarea").fill(commentText);
    await dialog.getByRole("button", { name: /send|submit/i }).click();

    // Success state.
    await expect(page.getByText(/sent/i)).toBeVisible();

    // Webhook received exactly one (successful) attempt.
    expect(hook.count()).toBe(1);
    const payload = hook.payloads.at(-1);
    expect(payload).toBeTruthy();

    // Non-empty body, in either json or discord shape.
    const bodyText: string = payload.body ?? payload.content ?? "";
    expect(bodyText).toContain(commentText);

    // Correct anchor percentages (json transport) within ±0.5.
    if (payload.anchor) {
      const dims = await page.evaluate(() => ({
        w: document.documentElement.scrollWidth,
        h: document.documentElement.scrollHeight,
        sx: window.scrollX,
        sy: window.scrollY,
      }));
      const expX = ((point.x + dims.sx) / dims.w) * 100;
      const expY = ((point.y + dims.sy) / dims.h) * 100;
      expect(Math.abs(payload.anchor.x_pct - expX)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(payload.anchor.y_pct - expY)).toBeLessThanOrEqual(0.5);
    }

    // No console errors / unhandled rejections in the flow.
    expect(errors).toEqual([]);
  });

  test("a numbered pin is placed and persists through submission", async ({
    page,
  }) => {
    await routeWebhook(page);
    await page.goto(DEMO);
    await page.getByRole("button", { name: "Give feedback" }).click();
    await page.mouse.click(200, 300);

    // A single numbered pin appears at the click point.
    const pin = page.locator(".pin");
    await expect(pin).toHaveCount(1);
    await expect(pin).toContainText("1");

    // After a successful submit the pin remains (marked as sent).
    await page.getByRole("dialog").locator("textarea").fill("pin should stay");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /send|submit/i })
      .click();
    await expect(page.getByText(/sent/i)).toBeVisible();
    await expect(page.locator(".pin")).toHaveCount(1);
  });
});
