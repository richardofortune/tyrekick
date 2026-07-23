import { describe, expect, it, vi } from "vitest";
import type { FeedbackRecord, ListFeedbackParams, TyrekickClient } from "../src/client.js";
import { retrospectiveTool } from "../src/tools.js";
import { makeRecord } from "./fixtures.js";

/**
 * A minimal fake TyrekickClient: retrospectiveTool only ever calls
 * listFeedback, so we stub just that and record the params it was called with.
 * The tool imports the real analyzer, so these exercise the whole path.
 */
function fakeClient(
  listFeedback: (params: ListFeedbackParams) => Promise<FeedbackRecord[]>,
): TyrekickClient {
  return { listFeedback: vi.fn(listFeedback) } as unknown as TyrekickClient;
}

describe("retrospective tool", () => {
  it("analyses a mix of feedback and returns a substantial, non-error report", async () => {
    const records = [
      makeRecord({
        id: "a",
        status: "resolved",
        route: "/pricing",
        app_version: "v1",
        body: "The CTA button overlaps the footer on mobile",
      }),
      makeRecord({
        id: "b",
        status: "declined",
        route: "/pricing",
        app_version: "v1",
        body: "The colour scheme feels off",
      }),
      makeRecord({
        id: "c",
        status: "open",
        route: "/",
        app_version: "v2",
        body: "Search returns nothing for valid queries",
      }),
    ];
    const client = fakeClient(async () => records);

    const result = await retrospectiveTool(client, {});
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    // Robust to the analyzer's exact wording: assert the report is substantial
    // and reflects the records' signals (an outcome count / status label).
    expect(text.length).toBeGreaterThan(20);
    expect(text.toLowerCase()).toMatch(/resolved|declined|open|3|retrospective/);
  });

  it("passes limit/project/since through to listFeedback", async () => {
    const spy = vi.fn(async () => [makeRecord()]);
    const client = fakeClient(spy);

    await retrospectiveTool(client, {
      project: "myNewThing",
      since: "2026-07-01T00:00:00.000Z",
      limit: 50,
    });
    expect(spy).toHaveBeenCalledWith({
      limit: 50,
      project: "myNewThing",
      since: "2026-07-01T00:00:00.000Z",
    });
  });

  it("defaults limit to 200 when not supplied", async () => {
    const spy = vi.fn(async () => [makeRecord()]);
    const client = fakeClient(spy);

    await retrospectiveTool(client, {});
    expect(spy).toHaveBeenCalledWith({
      limit: 200,
      project: undefined,
      since: undefined,
    });
  });

  it("returns a friendly non-error result for an empty feedback list", async () => {
    const client = fakeClient(async () => []);

    const result = await retrospectiveTool(client, {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it("surfaces a listFeedback failure as a tool error, never throws", async () => {
    const client = fakeClient(async () => {
      throw new Error("boom");
    });

    const result = await retrospectiveTool(client, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/boom/);
  });
});
