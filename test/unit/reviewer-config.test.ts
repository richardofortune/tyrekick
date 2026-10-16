/**
 * Host-supplied reviewer (config.reviewer): pages that know who's signed in
 * attribute every comment without asking. Unset must behave exactly as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { init, destroy } from "../../src/index";
import { installLayout, mockFetch, mockPointStack, submitFeedback, enterCommentMode, clickPoint, getShadow, cleanup } from "./helpers";

const CONFIG = { webhook: "https://example.test/hook", appVersion: "1.0.0", projectName: "demo", transport: "json" as const };

describe("config.reviewer", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    installLayout({ docW: 1000, docH: 2000, vw: 800, vh: 600 });
    const target = document.createElement("button");
    target.id = "cta";
    document.body.appendChild(target);
    mockPointStack([target]);
    fetchMock = mockFetch({ status: 200 });
  });

  afterEach(async () => {
    await cleanup(destroy);
  });

  it("unset: the optional name field works exactly as before", async () => {
    init(CONFIG);
    const p = await submitFeedback({ x: 250, y: 500, body: "hello", name: "Alice", fetchMock });
    expect(p.reviewer_name).toBe("Alice");
  });

  it("set: attributes every comment to the host's reviewer and hides the name field", async () => {
    init({ ...CONFIG, reviewer: "  dana@example.test  " });
    enterCommentMode();
    clickPoint(250, 500);
    expect(getShadow().querySelector('input[aria-label="Your name"]')).toBeNull();
    const p = await submitFeedback({ x: 260, y: 520, body: "hello", fetchMock });
    expect(p.reviewer_name).toBe("dana@example.test");
  });

  it("set: shows the reviewer on their own drawer entries", async () => {
    init({ ...CONFIG, reviewer: "dana@example.test" });
    await submitFeedback({ x: 250, y: 500, body: "hello", fetchMock });
    getShadow().querySelector<HTMLButtonElement>('[aria-label="View comments"]')!.click();
    await vi.waitFor(() => expect(getShadow().querySelector(".drawer .meta")?.textContent).toContain("dana@example.test"));
  });

  it("blank values count as unset", async () => {
    init({ ...CONFIG, reviewer: "   " });
    const p = await submitFeedback({ x: 250, y: 500, body: "hello", name: "Alice", fetchMock });
    expect(p.reviewer_name).toBe("Alice");
  });
});
