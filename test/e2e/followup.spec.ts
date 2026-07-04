import { test, expect } from "@playwright/test";
import { routeWebhook, collectErrors, DEMO } from "./helpers";

test.describe("follow-up flow", () => {
  test("drawer Follow up opens a prefilled composer and creates a second comment", async ({
    page,
  }) => {
    const hook = await routeWebhook(page);
    const errors = collectErrors(page);
    await page.goto(DEMO);

    // Submit the first comment.
    await page.getByRole("button", { name: "Give feedback" }).click();
    await page.mouse.click(240, 340);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.locator("textarea").fill("The hero copy is unclear");
    await dialog.getByRole("button", { name: /send|submit/i }).click();
    await expect(page.getByText(/sent — thank you/i)).toBeVisible();
    await expect(dialog).toBeHidden({ timeout: 5_000 }); // 1.5s auto-close
    await page.keyboard.press("Escape"); // leave comment mode

    // Open the drawer and follow up on comment 1.
    const toggle = page.getByRole("button", { name: "View comments" });
    await expect(toggle).toBeVisible();
    await toggle.click();
    const drawer = page.getByRole("complementary", { name: "Feedback comments" });
    await expect(drawer).toBeVisible();
    await drawer
      .getByRole("button", { name: "Add follow-up to comment 1" })
      .click();

    // Drawer closes; composer opens prefilled with the linkage prefix.
    await expect(drawer).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("textarea")).toHaveValue("Re #1: ");

    // Send the follow-up as a normal comment.
    await dialog.locator("textarea").fill("Re #1: agreed, and the CTA too");
    await dialog.getByRole("button", { name: /send|submit/i }).click();
    await expect(page.getByText(/sent — thank you/i)).toBeVisible();
    await expect(dialog).toBeHidden({ timeout: 5_000 });

    // The reply is marker-less: still exactly one pin on the page.
    await expect(page.locator(".pin")).toHaveCount(1);

    // Two normal webhook deliveries; the prefix is the only linkage.
    expect(hook.count()).toBe(2);
    const last = hook.payloads.at(-1);
    const bodyText: string = last.body ?? last.content ?? "";
    expect(bodyText).toContain("Re #1: agreed, and the CTA too");

    // Drawer lists both, with the follow-up nested under its parent and the
    // "Re #1:" linkage prefix hidden (nesting shows it; the payload keeps it).
    await toggle.click();
    await expect(drawer.getByText("Comments (2)")).toBeVisible();
    await expect(drawer.getByText("The hero copy is unclear")).toBeVisible();
    const reply = drawer.locator(".entry.reply");
    await expect(reply).toHaveCount(1);
    await expect(reply).toContainText("agreed, and the CTA too");
    await expect(reply).not.toContainText("Re #1:");
    const entries = drawer.locator(".entry");
    await expect(entries.nth(1)).toHaveClass(/reply/); // rendered directly under parent

    expect(errors).toEqual([]);
  });
});
