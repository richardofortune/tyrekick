/**
 * Payload construction must match src/types.ts FeedbackPayload exactly.
 * We drive the public API, mock the click + fetch, and inspect the POSTed JSON.
 */
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
  dialog,
  lastPostBody,
  cleanup,
  isUUID,
} from "./helpers";

const ISO_TZ =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

const CONFIG = {
  webhook: "https://example.test/hook",
  appVersion: "1.4.2",
  projectName: "Demo Project",
  transport: "json" as const,
};

describe("FeedbackPayload construction", () => {
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
    vi.useRealTimers();
    await cleanup(destroy);
  });

  it("produces a payload with exactly the schema-v2 keys and correct types", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-07-02T00:00:00.000Z");
    vi.setSystemTime(now);

    init(CONFIG);
    const p = await submitFeedback({
      x: 250,
      y: 500,
      body: "  the button looks off  ",
      name: "  Alice  ",
      fetchMock,
    });

    // Exact top-level key set — no missing, no extra fields.
    expect(Object.keys(p).sort()).toEqual(
      [
        "anchor",
        "app_version",
        "body",
        "created_at",
        "env",
        "id",
        "page_errors",
        "project_name",
        "reviewer_name",
        "route",
        "schema",
        "session_id",
        "url",
      ].sort(),
    );
    expect(Object.keys(p.anchor).sort()).toEqual(
      ["context", "element", "selector", "viewport", "x_pct", "y_pct"].sort(),
    );
    expect(Object.keys(p.anchor.viewport).sort()).toEqual(["h", "w"]);
    expect(Object.keys(p.anchor.element).sort()).toEqual(
      ["id", "label", "rect", "role", "tag", "testid", "text"].sort(),
    );
    expect(Object.keys(p.anchor.element.rect).sort()).toEqual(
      ["h", "w", "x", "y"].sort(),
    );
    expect(Object.keys(p.anchor.context).sort()).toEqual(
      ["heading", "landmark"].sort(),
    );
    expect(Object.keys(p.env).sort()).toEqual(
      ["dark", "dpr", "language", "screen", "touch", "user_agent"].sort(),
    );
    expect(Object.keys(p.env.screen).sort()).toEqual(["h", "w"]);

    // Scalars + types
    expect(p.schema).toBe(2);
    expect(isUUID(p.id)).toBe(true);
    expect(typeof p.created_at).toBe("string");
    expect(p.created_at).toMatch(ISO_TZ);
    expect(new Date(p.created_at).getTime()).toBe(now.getTime());
    expect(p.project_name).toBe("Demo Project");
    expect(p.app_version).toBe("1.4.2");
    expect(p.route).toBe(
      location.pathname + location.search + location.hash,
    );
    expect(p.url).toBe(location.href);
    expect(p.body).toBe("the button looks off"); // trimmed
    expect(p.reviewer_name).toBe("Alice"); // trimmed
    expect(isUUID(p.session_id)).toBe(true);

    // anchor
    expect(typeof p.anchor.x_pct).toBe("number");
    expect(typeof p.anchor.y_pct).toBe("number");
    expect(p.anchor.x_pct).toBeCloseTo(25.0, 5);
    expect(p.anchor.y_pct).toBeCloseTo(25.0, 5);
    expect(
      p.anchor.selector === null || typeof p.anchor.selector === "string",
    ).toBe(true);
    expect(p.anchor.viewport.w).toBe(800);
    expect(p.anchor.viewport.h).toBe(600);

    // anchor.element — the clicked button (values from the layout stubs)
    expect(p.anchor.element.tag).toBe("button");
    expect(p.anchor.element.id).toBe("cta");
    expect(p.anchor.element.testid).toBeNull();
    expect(p.anchor.element.role).toBeNull();
    expect(p.anchor.element.text).toBeNull(); // empty button → null
    expect(p.anchor.element.label).toBeNull();
    expect(p.anchor.element.rect).toEqual({ x: 0, y: 0, w: 200, h: 120 });

    // anchor.context — no headings or landmarks in this fixture
    expect(p.anchor.context.heading).toBeNull();
    expect(p.anchor.context.landmark).toBeNull();

    // env
    expect(typeof p.env.user_agent).toBe("string");
    expect(typeof p.env.language).toBe("string");
    expect(p.env.screen).toEqual({ w: 1280, h: 720 }); // stubbed in helpers
    expect(p.env.dpr).toBe(2); // stubbed in helpers
    expect(typeof p.env.dark).toBe("boolean");
    expect(typeof p.env.touch).toBe("boolean");

    // page_errors — none dispatched in this test
    expect(p.page_errors).toEqual([]);
  });

  it("matches a normalized snapshot", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-02T00:00:00.000Z"));

    init(CONFIG);
    const p = await submitFeedback({
      x: 250,
      y: 500,
      body: "snapshot body",
      name: "Rev",
      fetchMock,
    });

    // Normalize non-deterministic + environment-derived fields.
    const norm = {
      ...p,
      id: "<uuid>",
      session_id: "<uuid>",
      created_at: "<iso>",
      url: "<url>",
      route: "<route>",
      anchor: { ...p.anchor, selector: "<selector>" },
      env: { ...p.env, user_agent: "<ua>", language: "<lang>" },
    };

    expect(norm).toMatchInlineSnapshot(`
      {
        "anchor": {
          "context": {
            "heading": null,
            "landmark": null,
          },
          "element": {
            "id": "cta",
            "label": null,
            "rect": {
              "h": 120,
              "w": 200,
              "x": 0,
              "y": 0,
            },
            "role": null,
            "tag": "button",
            "testid": null,
            "text": null,
          },
          "selector": "<selector>",
          "viewport": {
            "h": 600,
            "w": 800,
          },
          "x_pct": 25,
          "y_pct": 25,
        },
        "app_version": "1.4.2",
        "body": "snapshot body",
        "created_at": "<iso>",
        "env": {
          "dark": false,
          "dpr": 2,
          "language": "<lang>",
          "screen": {
            "h": 720,
            "w": 1280,
          },
          "touch": false,
          "user_agent": "<ua>",
        },
        "id": "<uuid>",
        "page_errors": [],
        "project_name": "Demo Project",
        "reviewer_name": "Rev",
        "route": "<route>",
        "schema": 2,
        "session_id": "<uuid>",
        "url": "<url>",
      }
    `);
  });

  it("reviewer_name is null when the name field is left empty", async () => {
    init(CONFIG);
    const p = await submitFeedback({
      x: 250,
      y: 500,
      body: "no name given",
      name: "",
      fetchMock,
    });
    expect(p.reviewer_name).toBeNull();
  });

  it("reviewer_name is null when fields.name is disabled", async () => {
    init({ ...CONFIG, fields: { name: false } });
    const p = await submitFeedback({
      x: 250,
      y: 500,
      body: "no name field",
      fetchMock,
    });
    expect(p.reviewer_name).toBeNull();
  });

  it("defaults project_name to document.title when not provided", async () => {
    document.title = "Untitled Prototype";
    init({ webhook: CONFIG.webhook, appVersion: CONFIG.appVersion });
    const p = await submitFeedback({
      x: 250,
      y: 500,
      body: "default project name",
      fetchMock,
    });
    expect(p.project_name).toBe("Untitled Prototype");
  });

  it("keeps one session_id per page load but a fresh id per comment", async () => {
    init(CONFIG);

    // First submission.
    enterCommentMode();
    clickPoint(100, 100);
    fillComment("first comment");
    submit();
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledTimes(1),
    );
    const first = lastPostBody(fetchMock);

    // Success auto-closes the composer after ~1.5s; comment mode stays active.
    await vi.waitFor(() => expect(dialog()).toBeNull(), { timeout: 3000 });

    // Second submission reuses the same session, still open comment mode.
    clickPoint(200, 400);
    fillComment("second comment");
    submit();
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledTimes(2),
    );
    const second = lastPostBody(fetchMock);

    expect(first.session_id).toBe(second.session_id);
    expect(first.id).not.toBe(second.id);
  });

  it("posts application/json with the raw payload for transport 'json'", async () => {
    init(CONFIG);
    await submitFeedback({ x: 250, y: 500, body: "hi", fetchMock });
    const [url, opts] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe(CONFIG.webhook);
    expect((opts as RequestInit).method).toMatch(/post/i);
    const headers = new Headers((opts as RequestInit).headers);
    expect(headers.get("content-type")).toMatch(/application\/json/i);
  });
});
