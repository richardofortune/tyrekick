import { test, expect } from "@playwright/test";
import { routeWebhook, collectErrors, DEMO } from "./helpers";

/**
 * The unsent-work loop: failed comments survive reload and must be closable
 * from the drawer (Retry / Discard), re-attached to the element they were
 * about — plus the composer safety rails (Esc keeps the draft, Cmd/Ctrl+Enter
 * sends).
 */

async function failComment(
  page: import("@playwright/test").Page,
  x: number,
  y: number,
  text: string,
) {
  await page.getByRole("button", { name: "Give feedback" }).click();
  await page.mouse.click(x, y);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator("textarea").fill(text);
  await dialog.getByRole("button", { name: /send|submit/i }).click();
  // initial attempt + automatic 2s retry both fail
  await expect(page.getByText(/couldn't send/i)).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape"); // dismiss composer (failed pin stays)
  await page.keyboard.press("Escape"); // leave comment mode
}

test.describe("unsent-work recovery", () => {
  test("a failed comment can be retried from the drawer after a reload", async ({ page }) => {
    const hook = await routeWebhook(page, { failTimes: 2 });
    const errors = collectErrors(page);
    await page.goto(DEMO);
    await failComment(page, 300, 400, "Retry me after reload");

    await page.reload();

    // Restored: toggle visible with the failure flagged red.
    const toggle = page.getByRole("button", { name: "View comments" });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveClass(/failed/);

    await toggle.click();
    const drawer = page.getByRole("complementary", { name: "Feedback comments" });
    await expect(drawer.getByText("Retry me after reload")).toBeVisible();
    await expect(drawer.getByText("not sent")).toBeVisible();

    await drawer.getByRole("button", { name: "Retry sending comment 1" }).click();
    await expect(drawer.getByText("not sent")).toBeHidden();
    await expect(toggle).not.toHaveClass(/failed/);
    expect(hook.count()).toBe(3); // 2 failed attempts + 1 successful retry

    // Delivered: the unsent-work store empties; the comment graduates to the
    // receipts store and survives the next reload as a sent pin.
    await page.reload();
    await expect(page.getByRole("button", { name: "View comments" })).toBeVisible();
    const keys = await page.evaluate(() => ({
      pins: localStorage.getItem("tyrekick:pins:" + location.pathname),
      receipts: localStorage.getItem("tyrekick:receipts:" + location.pathname),
    }));
    expect(keys.pins).toBeNull();
    expect(keys.receipts).not.toBeNull();

    expect(errors).toEqual([]);
  });

  test("a failed comment can be discarded from the drawer", async ({ page }) => {
    await routeWebhook(page, { failTimes: 99 });
    await page.goto(DEMO);
    await failComment(page, 300, 400, "Never going to send");

    await page.reload();
    await page.getByRole("button", { name: "View comments" }).click();
    const drawer = page.getByRole("complementary", { name: "Feedback comments" });
    await drawer.getByRole("button", { name: "Discard comment 1" }).click();
    await expect(drawer.getByText("No comments yet.")).toBeVisible();

    await page.reload();
    await expect(page.getByRole("button", { name: "View comments" })).toBeHidden();
  });

  test("restored pins re-attach to their element when the viewport changes", async ({
    page,
  }) => {
    await routeWebhook(page, { failTimes: 99 });
    await page.setViewportSize({ width: 1920, height: 900 });
    await page.goto(DEMO);

    const before = await page.locator("#return").boundingBox();
    if (!before) throw new Error("#return not found");
    await failComment(
      page,
      before.x + before.width / 2,
      before.y + before.height / 2,
      "The return field is broken",
    );

    await page.setViewportSize({ width: 1100, height: 800 });
    await page.reload();
    await page.getByRole("button", { name: "View comments" }).click(); // shows pins

    const el = await page.locator("#return").boundingBox();
    const pin = await page.locator(".pin").boundingBox();
    if (!el || !pin) throw new Error("element or pin missing after reload");
    const cx = pin.x + pin.width / 2;
    const cy = pin.y + pin.height / 2;
    expect(cx).toBeGreaterThanOrEqual(el.x - 2);
    expect(cx).toBeLessThanOrEqual(el.x + el.width + 2);
    expect(cy).toBeGreaterThanOrEqual(el.y - 2);
    expect(cy).toBeLessThanOrEqual(el.y + el.height + 2);
  });
});

test.describe("composer safety rails", () => {
  test("Esc keeps the typed draft; Cancel discards it", async ({ page }) => {
    await routeWebhook(page);
    await page.goto(DEMO);
    await page.getByRole("button", { name: "Give feedback" }).click();
    await page.mouse.click(300, 400);
    const dialog = page.getByRole("dialog");
    await dialog.locator("textarea").fill("Half-written thought");

    await page.keyboard.press("Escape"); // dismiss — draft must survive
    await expect(dialog).toBeHidden();

    await page.mouse.click(400, 500); // still in comment mode
    await expect(dialog.locator("textarea")).toHaveValue("Half-written thought");

    await dialog.getByRole("button", { name: "Cancel" }).click(); // explicit discard
    await page.mouse.click(420, 520);
    await expect(dialog.locator("textarea")).toHaveValue("");
  });

  test("Cmd/Ctrl+Enter submits the comment", async ({ page }) => {
    const hook = await routeWebhook(page);
    await page.goto(DEMO);
    await page.getByRole("button", { name: "Give feedback" }).click();
    await page.mouse.click(300, 400);
    const dialog = page.getByRole("dialog");
    await dialog.locator("textarea").fill("Keyboard send");
    await page.keyboard.press("Control+Enter");
    await expect(page.getByText(/sent — thank you/i)).toBeVisible();
    expect(hook.count()).toBe(1);
  });
});
