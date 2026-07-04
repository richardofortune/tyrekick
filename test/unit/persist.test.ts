import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { init, destroy } from "../../src/index";
import {
  installLayout,
  mockFetch,
  mockPointStack,
  submitFeedback,
  enterCommentMode,
  clickPoint,
  fillComment,
  submit,
  getShadow,
  cleanup,
} from "./helpers";

const CONFIG = {
  webhook: "https://example.test/hook",
  appVersion: "1.0.0",
};

describe("persist semantics", () => {
  beforeEach(() => {
    installLayout({ docW: 1000, docH: 2000, vw: 800, vh: 600 });
    localStorage.clear();
    const target = document.createElement("button");
    target.id = "cta";
    document.body.appendChild(target);
    mockPointStack([target]);
  });

  afterEach(async () => {
    vi.useRealTimers();
    localStorage.clear();
    await cleanup(destroy);
  });

  it("does not persist successfully submitted comments in localStorage", async () => {
    const fetchMock = mockFetch({ status: 200 });
    init(CONFIG);

    await submitFeedback({
      x: 250,
      y: 500,
      body: "sent comments should not be persisted",
      fetchMock,
    });

    await vi.waitFor(() =>
      expect(localStorage.getItem("tyrekick:pins:" + location.pathname)).toBeNull(),
    );
    await vi.waitFor(() =>
      expect(localStorage.getItem("tyrekick:draft:" + location.pathname)).toBeNull(),
    );
  });

  it("persists failed comments for retry after reload", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch({ status: 500, body: { ok: false } });
    init(CONFIG);

    enterCommentMode();
    clickPoint(250, 500);
    fillComment("failed comments should be recoverable");
    submit();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const saved = localStorage.getItem("tyrekick:pins:" + location.pathname);
    expect(saved).not.toBeNull();
    expect(saved).toContain("failed comments should be recoverable");
  });

  it("persists stable ids and reply links separately from display numbers", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch({ status: 500, body: { ok: false } });
    init(CONFIG);

    enterCommentMode();
    clickPoint(250, 500);
    fillComment("root comment");
    submit();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const toggle = getShadow().querySelector<HTMLButtonElement>(
      '[aria-label="View comments"]',
    );
    expect(toggle).not.toBeNull();
    toggle!.click();

    const followUp = getShadow().querySelector<HTMLButtonElement>(
      '[aria-label="Add follow-up to comment 1"]',
    );
    expect(followUp).not.toBeNull();
    followUp!.click();

    fillComment("Re #1: reply comment");
    submit();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    const raw = localStorage.getItem("tyrekick:pins:" + location.pathname);
    expect(raw).not.toBeNull();
    const saved = JSON.parse(raw || "[]") as Array<{
      i: string;
      n: number;
      b: string;
      ri?: string | null;
    }>;
    expect(saved).toHaveLength(2);
    expect(saved[0].i).toBeTruthy();
    expect(saved[1].i).toBeTruthy();
    expect(saved[0].i).not.toBe(saved[1].i);
    expect(saved[1].ri).toBe(saved[0].i);
    expect(saved[0].n).toBe(1);
  });
});
