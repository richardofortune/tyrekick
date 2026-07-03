import { afterEach, describe, expect, it, vi } from "vitest";
import { TyrekickClient } from "../src/client.js";
import {
  aggregateStats,
  feedbackStatsTool,
  triageFeedbackTool,
  getFeedbackTool,
  listFeedbackTool,
  resolveFeedbackTool,
} from "../src/tools.js";
import { jsonResponse, makeRecord, makeV2Record } from "./fixtures.js";

const BASE = "https://tyrekick.test.workers.dev";

function makeClient(fetchMock: ReturnType<typeof vi.fn>): TyrekickClient {
  vi.stubGlobal("fetch", fetchMock);
  return new TyrekickClient({ baseUrl: BASE, token: "sekret" });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("list_feedback tool", () => {
  it("formats a readable summary per item (id, created_at, status, route, body, reviewer, selector, app_version)", async () => {
    const record = makeRecord();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, items: [record] }));
    const client = makeClient(fetchMock);

    const result = await listFeedbackTool(client, { status: "open" });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain(record.id);
    expect(text).toContain("OPEN");
    expect(text).toContain("/pricing");
    expect(text).toContain("2026-07-01T10:00:00.000Z");
    expect(text).toContain("The CTA button overlaps the footer on mobile");
    expect(text).toContain("Jane");
    expect(text).toContain("main > section.cta > button");
    expect(text).toContain("v1.2.0");
  });

  it("shows Anonymous and (no selector) for null fields", async () => {
    const record = makeRecord({
      reviewer_name: null,
      anchor: { x_pct: 1, y_pct: 2, selector: null, viewport: { w: 800, h: 600 } },
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, items: [record] }));
    const client = makeClient(fetchMock);
    const text = (await listFeedbackTool(client, {})).content[0].text;
    expect(text).toContain("Anonymous");
    expect(text).toContain("(no selector)");
  });

  it("enriches v2 records with element text, heading/landmark, and page_errors count", async () => {
    const record = makeV2Record();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, items: [record] }));
    const client = makeClient(fetchMock);

    const result = await listFeedbackTool(client, {});
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain('element: <button> "Find trips"');
    expect(text).toContain('under: "Your itinerary"');
    expect(text).toContain("landmark: main > section#pricing");
    expect(text).toContain("page_errors: 2");
    expect(text).not.toContain("undefined");
  });

  it("falls back to the element label when there is no visible text", async () => {
    const record = makeV2Record();
    record.anchor = {
      ...record.anchor,
      element: { ...record.anchor?.element, tag: "input", text: null, label: "Search trips" },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, items: [record] }));
    const client = makeClient(fetchMock);
    const text = (await listFeedbackTool(client, {})).content[0].text;
    expect(text).toContain('element: <input> label: "Search trips"');
  });

  it("renders v1 records exactly as before — no v2 lines and no undefined noise", async () => {
    const record = makeRecord(); // v1: no element, no context, no page_errors
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, items: [record] }));
    const client = makeClient(fetchMock);

    const text = (await listFeedbackTool(client, {})).content[0].text;
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("element:");
    expect(text).not.toContain("under:");
    expect(text).not.toContain("landmark:");
    expect(text).not.toContain("page_errors:");
    // The v1 summary lines are all still there, in shape.
    expect(text).toContain(record.id);
    expect(text).toContain("selector: main > section.cta > button");
    expect(text).toContain("> The CTA button overlaps the footer on mobile");
  });

  it("skips empty page_errors and empty context on v2 records", async () => {
    const record = makeV2Record({ page_errors: [] });
    record.anchor = { ...record.anchor, context: { heading: null, landmark: null } };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, items: [record] }));
    const client = makeClient(fetchMock);
    const text = (await listFeedbackTool(client, {})).content[0].text;
    expect(text).toContain('element: <button> "Find trips"');
    expect(text).not.toContain("page_errors:");
    expect(text).not.toContain("under:");
    expect(text).not.toContain("landmark:");
    expect(text).not.toContain("undefined");
  });

  it("reports an empty result without erroring", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, items: [] }));
    const client = makeClient(fetchMock);
    const result = await listFeedbackTool(client, { status: "resolved" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/No feedback found/);
    expect(result.content[0].text).toContain("status=resolved");
  });

  it("returns the 401 message as a tool error instead of throwing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, error: "unauthorized" }, 401));
    const client = makeClient(fetchMock);
    const result = await listFeedbackTool(client, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      "Unauthorized — check TYREKICK_TOKEN and that `wrangler secret put TYREKICK_TOKEN` was run",
    );
  });

  it("returns network failures as tool errors instead of throwing", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("getaddrinfo ENOTFOUND"));
    const client = makeClient(fetchMock);
    const result = await listFeedbackTool(client, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Network error/);
  });
});

describe("get_feedback tool", () => {
  it("returns the full record as JSON, including anchor and env", async () => {
    const record = makeRecord();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, record }));
    const client = makeClient(fetchMock);

    const result = await getFeedbackTool(client, { id: record.id });
    expect(result.isError).toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/feedback/${record.id}`);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe(record.id);
    expect(parsed.anchor.selector).toBe("main > section.cta > button");
    expect(parsed.anchor.viewport).toEqual({ w: 390, h: 844 });
    expect(parsed.env.language).toBe("en-NZ");
  });

  it("surfaces a 404 as a tool error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, error: "not found" }, 404));
    const client = makeClient(fetchMock);
    const result = await getFeedbackTool(client, { id: "missing" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/404/);
  });
});

describe("resolve_feedback tool", () => {
  it("PATCHes status resolved with the note and confirms", async () => {
    const resolved = makeRecord({
      status: "resolved",
      resolved_at: "2026-07-03T09:00:00.000Z",
      resolution_note: "moved the CTA above the footer",
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, record: resolved }));
    const client = makeClient(fetchMock);

    const result = await resolveFeedbackTool(client, {
      id: resolved.id,
      note: "moved the CTA above the footer",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/feedback/${resolved.id}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({
      status: "resolved",
      note: "moved the CTA above the footer",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain(`Resolved feedback ${resolved.id}`);
    expect(result.content[0].text).toContain("moved the CTA above the footer");
  });

  it("surfaces the 401 message as a tool error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, error: "unauthorized" }, 401));
    const client = makeClient(fetchMock);
    const result = await resolveFeedbackTool(client, { id: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("check TYREKICK_TOKEN");
  });
});

describe("feedback_stats tool", () => {
  it("requests limit=200 and aggregates by status, route, app_version", async () => {
    const records = [
      makeRecord({ id: "a", status: "open", route: "/", app_version: "v1" }),
      makeRecord({ id: "b", status: "open", route: "/pricing", app_version: "v1" }),
      makeRecord({ id: "c", status: "resolved", route: "/pricing", app_version: "v2" }),
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, items: records }));
    const client = makeClient(fetchMock);

    const result = await feedbackStatsTool(client);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/feedback");
    expect(url.searchParams.get("limit")).toBe("200");

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("open: 2");
    expect(text).toContain("resolved: 1");
    expect(text).toContain("/pricing: 2");
    expect(text).toContain("/: 1");
    expect(text).toContain("v1: 2");
    expect(text).toContain("v2: 1");
  });

  it("aggregateStats defaults missing fields sensibly", () => {
    const stats = aggregateStats([
      makeRecord({ status: undefined, route: undefined, app_version: undefined }),
    ]);
    expect(stats.byStatus.open).toBe(1);
    expect(stats.byRoute["(unknown)"]).toBe(1);
    expect(stats.byAppVersion["(unknown)"]).toBe(1);
  });

  it("is unaffected by v2 fields — v1 and v2 records aggregate identically", async () => {
    const records = [
      makeRecord({ id: "a", status: "open", route: "/pricing", app_version: "v1" }),
      makeV2Record({ id: "b", status: "open", route: "/pricing", app_version: "v1" }),
      makeV2Record({ id: "c", status: "resolved", route: "/", app_version: "v2" }),
    ];
    const stats = aggregateStats(records);
    expect(stats.total).toBe(3);
    expect(stats.byStatus).toEqual({ open: 2, resolved: 1 });
    expect(stats.byRoute).toEqual({ "/pricing": 2, "/": 1 });
    expect(stats.byAppVersion).toEqual({ v1: 2, v2: 1 });

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, items: records }));
    const client = makeClient(fetchMock);
    const text = (await feedbackStatsTool(client)).content[0].text;
    expect(text).toContain("open: 2");
    expect(text).toContain("resolved: 1");
    expect(text).not.toContain("undefined");
  });

  it("returns errors as tool errors, never throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("boom"));
    const client = makeClient(fetchMock);
    const result = await feedbackStatsTool(client);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/boom/);
  });

  it("triage: PATCHes approved with the right body and flags readiness", async () => {
    const rec = makeRecord({ status: "approved", resolution_note: null });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, item: rec }));
    const client = makeClient(fetchMock);
    const result = await triageFeedbackTool(client, { id: rec.id, status: "approved" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`/feedback/${rec.id}`);
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ status: "approved" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("approved");
    expect(result.content[0].text).toContain("Ready to action");
  });

  it("triage: declined carries the reason note", async () => {
    const rec = makeRecord({ status: "declined", resolution_note: "intentional design" });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, item: rec }));
    const client = makeClient(fetchMock);
    const result = await triageFeedbackTool(client, {
      id: rec.id,
      status: "declined",
      note: "intentional design",
    });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      status: "declined",
      note: "intentional design",
    });
    expect(result.content[0].text).toContain("declined");
    expect(result.content[0].text).toContain("intentional design");
    expect(result.content[0].text).not.toContain("Ready to action");
  });

  it("triage: errors surface as tool errors, never throw", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("boom"));
    const client = makeClient(fetchMock);
    const result = await triageFeedbackTool(client, { id: "x", status: "approved" });
    expect(result.isError).toBe(true);
  });

  it("passes the project scope to the worker and labels the output", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, items: [makeRecord()] }));
    const client = makeClient(fetchMock);
    const text = (await feedbackStatsTool(client, { project: "myNewThing" })).content[0].text;
    const parsed = new URL(fetchMock.mock.calls[0][0] as string);
    expect(parsed.searchParams.get("project")).toBe("myNewThing");
    expect(parsed.searchParams.get("limit")).toBe("200");
    expect(text).toContain('for project "myNewThing"');
  });
});
