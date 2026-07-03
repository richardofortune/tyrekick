import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TyrekickApiError,
  TyrekickClient,
  UNAUTHORIZED_MESSAGE,
  extractList,
  extractRecord,
} from "../src/client.js";
import { jsonResponse, makeRecord } from "./fixtures.js";

const BASE = "https://tyrekick.test.workers.dev";

function makeClient(fetchMock: ReturnType<typeof vi.fn>): TyrekickClient {
  vi.stubGlobal("fetch", fetchMock);
  return new TyrekickClient({ baseUrl: BASE, token: "sekret" });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TyrekickClient.listFeedback", () => {
  it("GETs /feedback with query params and the bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, items: [makeRecord()] }));
    const client = makeClient(fetchMock);

    const records = await client.listFeedback({
      status: "open",
      route: "/pricing",
      since: "2026-06-30T00:00:00Z",
      limit: 25,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.origin).toBe(BASE);
    expect(parsed.pathname).toBe("/feedback");
    expect(parsed.searchParams.get("status")).toBe("open");
    expect(parsed.searchParams.get("route")).toBe("/pricing");
    expect(parsed.searchParams.get("since")).toBe("2026-06-30T00:00:00Z");
    expect(parsed.searchParams.get("limit")).toBe("25");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer sekret",
    );
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(makeRecord().id);
  });

  it("omits absent query params entirely", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, items: [] }));
    const client = makeClient(fetchMock);
    await client.listFeedback({});
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/feedback`);
  });

  it("strips trailing slashes from the base URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new TyrekickClient({ baseUrl: `${BASE}/`, token: "t" });
    await client.listFeedback({});
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/feedback`);
  });
});

describe("TyrekickClient.getFeedback", () => {
  it("GETs /feedback/:id with the id URL-encoded", async () => {
    const record = makeRecord();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, record }));
    const client = makeClient(fetchMock);

    const got = await client.getFeedback("abc/../def");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/feedback/abc%2F..%2Fdef`);
    expect(got.id).toBe(record.id);
  });
});

describe("TyrekickClient.resolveFeedback", () => {
  it("PATCHes /feedback/:id with status resolved and the note", async () => {
    const resolved = makeRecord({
      status: "resolved",
      resolved_at: "2026-07-03T09:00:00.000Z",
      resolution_note: "fixed overlap",
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, record: resolved }));
    const client = makeClient(fetchMock);

    const got = await client.resolveFeedback(resolved.id, "fixed overlap");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/feedback/${resolved.id}`);
    expect((init as RequestInit).method).toBe("PATCH");
    expect(
      (init as { headers: Record<string, string> }).headers["Content-Type"],
    ).toBe("application/json");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      status: "resolved",
      note: "fixed overlap",
    });
    expect(got.status).toBe("resolved");
  });

  it("omits note from the body when not provided", async () => {
    const record = makeRecord({ status: "resolved" });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, record }));
    const client = makeClient(fetchMock);
    await client.resolveFeedback(record.id);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      status: "resolved",
    });
  });
});

describe("error handling", () => {
  it("throws the exact actionable message on 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, error: "unauthorized" }, 401));
    const client = makeClient(fetchMock);
    await expect(client.listFeedback({})).rejects.toThrow(
      "Unauthorized — check TYREKICK_TOKEN and that `wrangler secret put TYREKICK_TOKEN` was run",
    );
    await expect(client.listFeedback({})).rejects.toBeInstanceOf(TyrekickApiError);
  });

  it("throws a clear error on other non-2xx statuses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, error: "not found" }, 404));
    const client = makeClient(fetchMock);
    await expect(client.getFeedback("nope")).rejects.toThrow(/HTTP 404.*not found/);
  });

  it("wraps network failures with the URL and a hint", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const client = makeClient(fetchMock);
    await expect(client.listFeedback({})).rejects.toThrow(
      /Network error calling https:\/\/tyrekick\.test\.workers\.dev\/feedback.*fetch failed/,
    );
  });

  it("treats a 2xx body of ok:false as an error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: "kv write" }));
    const client = makeClient(fetchMock);
    await expect(client.listFeedback({})).rejects.toThrow(/kv write/);
  });
});

describe("response shape tolerance", () => {
  it("extractList accepts items/records/feedback/results/data keys and bare arrays", () => {
    const r = makeRecord();
    for (const key of ["items", "records", "feedback", "results", "data"]) {
      expect(extractList({ ok: true, [key]: [r] })).toHaveLength(1);
    }
    expect(extractList([r])).toHaveLength(1);
    expect(extractList({ ok: true })).toHaveLength(0);
  });

  it("extractRecord accepts wrapped and flattened records", () => {
    const r = makeRecord();
    expect(extractRecord({ ok: true, record: r })?.id).toBe(r.id);
    expect(extractRecord({ ok: true, feedback: r })?.id).toBe(r.id);
    expect(extractRecord({ ok: true, ...r })?.id).toBe(r.id);
    expect(extractRecord({ ok: true })).toBeNull();
  });
});

it("UNAUTHORIZED_MESSAGE matches the contract wording", () => {
  expect(UNAUTHORIZED_MESSAGE).toBe(
    "Unauthorized — check TYREKICK_TOKEN and that `wrangler secret put TYREKICK_TOKEN` was run",
  );
});
