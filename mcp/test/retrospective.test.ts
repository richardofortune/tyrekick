import { describe, expect, it } from "vitest";
import type { FeedbackRecord } from "../src/client.js";
import {
  classifyIntent,
  formatRetrospective,
  retrospective,
  type Intent,
} from "../src/retrospective.js";

let seq = 0;
function rec(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  seq += 1;
  return {
    id: `id-${seq}`,
    created_at: "2026-07-01T10:00:00.000Z",
    app_version: "v1.0.0",
    route: "/",
    body: "",
    status: "open",
    ...overrides,
  };
}

describe("classifyIntent", () => {
  const cases: Array<[string, Partial<FeedbackRecord>, Intent]> = [
    ["bug via keyword", { body: "This button is broken and does not work" }, "bug"],
    ["a11y", { body: "Please improve the aria labels and keyboard focus" }, "a11y"],
    ["data", { body: "The total shows the wrong number here" }, "data"],
    ["layout", { body: "These two cards overlap on mobile" }, "layout"],
    ["copy", { body: "There is a typo in this heading" }, "copy"],
    ["request", { body: "Could you add a dark mode toggle" }, "request"],
    ["question via start word", { body: "Where is the save option" }, "question"],
    ["question via ? word", { body: "How does this filter behave" }, "question"],
    ["praise", { body: "I love this, looks good" }, "praise"],
    ["other", { body: "hmm interesting" }, "other"],
    ["empty", { body: "" }, "other"],
  ];
  for (const [name, ov, expected] of cases) {
    it(`classifies ${name} -> ${expected}`, () => {
      expect(classifyIntent(rec(ov))).toBe(expected);
    });
  }

  it("page_errors always wins as bug regardless of body", () => {
    expect(
      classifyIntent(rec({ body: "I love this, looks good", page_errors: ["TypeError: boom"] })),
    ).toBe("bug");
  });

  it("clean question and praise buckets when nothing earlier matches", () => {
    expect(classifyIntent(rec({ body: "Why is this here" }))).toBe("question");
    expect(classifyIntent(rec({ body: "this ends in a question mark?" }))).toBe("question");
    expect(classifyIntent(rec({ body: "awesome 🎉" }))).toBe("praise");
  });
});

describe("retrospective outcomes", () => {
  it("counts and rates for a mixed set; rates fractions in [0,1]", () => {
    const report = retrospective([
      rec({ status: "resolved" }),
      rec({ status: "resolved" }),
      rec({ status: "declined" }),
      rec({ status: "open" }),
      rec({ status: "approved" }), // -> open bucket
      rec({ status: undefined }), // -> open bucket
    ]);
    expect(report.total).toBe(6);
    expect(report.outcomes.resolved).toBe(2);
    expect(report.outcomes.declined).toBe(1);
    expect(report.outcomes.open).toBe(3);
    expect(report.outcomes.resolveRate).toBeCloseTo(2 / 6);
    expect(report.outcomes.declineRate).toBeCloseTo(1 / 6);
    expect(report.outcomes.openRate).toBeCloseTo(3 / 6);
    const sum =
      report.outcomes.resolveRate + report.outcomes.declineRate + report.outcomes.openRate;
    expect(sum).toBeCloseTo(1);
  });

  it("total===0 -> all rates 0, no throw", () => {
    const report = retrospective([]);
    expect(report.total).toBe(0);
    expect(report.outcomes.resolveRate).toBe(0);
    expect(report.outcomes.declineRate).toBe(0);
    expect(report.outcomes.openRate).toBe(0);
    expect(report.window).toEqual({ from: null, to: null });
    expect(report.intents).toEqual([]);
    expect(report.blindSpots).toEqual([]);
  });
});

describe("intents aggregation", () => {
  it("sorted desc by count with correct per-intent outcome split", () => {
    const report = retrospective([
      rec({ body: "broken button", status: "resolved" }), // bug
      rec({ body: "the page is broken here", status: "declined" }), // bug
      rec({ body: "another crash", status: "open" }), // bug
      rec({ body: "typo here", status: "resolved" }), // copy
      rec({ body: "add a toggle", status: "open" }), // request
    ]);
    expect(report.intents[0].intent).toBe("bug");
    expect(report.intents[0].count).toBe(3);
    expect(report.intents[0].resolved).toBe(1);
    expect(report.intents[0].declined).toBe(1);
    expect(report.intents[0].open).toBe(1);
    // sorted desc
    const counts = report.intents.map((i) => i.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    // only occurring intents present
    const names = report.intents.map((i) => i.intent).sort();
    expect(names).toEqual(["bug", "copy", "request"]);
  });
});

describe("blindSpots", () => {
  const sharedElement = {
    x_pct: 1,
    y_pct: 2,
    selector: "main > button.cta",
    viewport: { w: 390, h: 844 },
    element: { tag: "button", text: "Find trips" },
  };

  it("same element flagged 3x -> count 3 with up to 2 examples; once-flagged absent; sorted desc", () => {
    const report = retrospective([
      rec({ body: "broken here", anchor: { ...sharedElement } }),
      rec({ body: "typo in this label", anchor: { ...sharedElement } }),
      rec({ body: "add a spinner", anchor: { ...sharedElement } }),
      // a second spot flagged twice
      rec({ body: "overlaps footer", anchor: { selector: "footer", viewport: { w: 1, h: 1 } } }),
      rec({ body: "spacing wrong", anchor: { selector: "footer", viewport: { w: 1, h: 1 } } }),
      // a singleton — must be absent
      rec({ body: "lonely", anchor: { selector: "aside", viewport: { w: 1, h: 1 } } }),
    ]);

    expect(report.blindSpots.length).toBe(2);
    const top = report.blindSpots[0];
    expect(top.where).toBe('<button> "Find trips"');
    expect(top.count).toBe(3);
    expect(top.examples.length).toBe(2);
    expect(top.intents.length).toBeGreaterThanOrEqual(1);

    // sorted desc by count
    expect(report.blindSpots[0].count).toBeGreaterThanOrEqual(report.blindSpots[1].count);

    // singleton absent
    expect(report.blindSpots.some((b) => b.where === "aside")).toBe(false);
  });

  it("falls back through heading, selector, route, then (unknown)", () => {
    const report = retrospective([
      rec({ body: "x", anchor: { context: { heading: "Your itinerary" } } }),
      rec({ body: "y", anchor: { context: { heading: "Your itinerary" } } }),
    ]);
    expect(report.blindSpots[0].where).toBe('heading: "Your itinerary"');
  });
});

describe("byVersion + window", () => {
  it("versions sorted desc; window is min/max created_at", () => {
    const report = retrospective([
      rec({ app_version: "v1", created_at: "2026-07-02T00:00:00.000Z" }),
      rec({ app_version: "v2", created_at: "2026-07-01T00:00:00.000Z" }),
      rec({ app_version: "v2", created_at: "2026-07-05T00:00:00.000Z" }),
      rec({ app_version: undefined, created_at: undefined }),
    ]);
    expect(report.byVersion[0]).toEqual({ version: "v2", count: 2 });
    expect(report.byVersion.some((v) => v.version === "(unknown)")).toBe(true);
    expect(report.window.from).toBe("2026-07-01T00:00:00.000Z");
    expect(report.window.to).toBe("2026-07-05T00:00:00.000Z");
  });
});

describe("moat: aggregate is content-free", () => {
  it("aggregate contains no comment bodies or reviewer names", () => {
    const secretBodies = [
      "SUPERSECRETBODYALPHA the button is broken",
      "SUPERSECRETBODYBRAVO typo in the heading label",
      "SUPERSECRETBODYCHARLIE please add a toggle",
    ];
    const secretNames = ["ReviewerZaphod", "ReviewerTrillian"];
    const records: FeedbackRecord[] = [
      rec({
        body: secretBodies[0],
        reviewer_name: secretNames[0],
        status: "resolved",
        anchor: { selector: "main > button", viewport: { w: 1, h: 1 } },
      }),
      rec({
        body: secretBodies[1],
        reviewer_name: secretNames[1],
        status: "declined",
        anchor: { selector: "main > button", viewport: { w: 1, h: 1 } },
      }),
      rec({ body: secretBodies[2], reviewer_name: secretNames[0], status: "open" }),
    ];

    const report = retrospective(records);
    const aggJson = JSON.stringify(report.aggregate);

    for (const b of secretBodies) {
      // no body substring, and no distinctive token from it, leaks
      expect(aggJson).not.toContain(b);
      expect(aggJson).not.toContain(b.split(" ")[0]); // the SUPERSECRET... token
    }
    for (const n of secretNames) {
      expect(aggJson).not.toContain(n);
    }

    // it still carries the useful numbers + labels
    expect(report.aggregate.total).toBe(3);
    expect(report.aggregate.blindSpotCount).toBe(report.blindSpots.length);
    expect(Object.keys(report.aggregate.intents).length).toBeGreaterThan(0);
    expect(report.aggregate.versions["v1.0.0"]).toBe(3);
    expect(report.aggregate.outcomes).toEqual({ resolved: 1, declined: 1, open: 1 });
  });
});

describe("formatRetrospective", () => {
  it("returns a non-empty string with the key section labels", () => {
    const report = retrospective([
      rec({ body: "broken button", status: "resolved", app_version: "v1" }),
      rec({ body: "typo here", status: "declined", app_version: "v1" }),
      rec({
        body: "overlaps footer",
        status: "open",
        app_version: "v2",
        anchor: { selector: "footer", viewport: { w: 1, h: 1 } },
      }),
      rec({
        body: "footer still off",
        status: "open",
        app_version: "v2",
        anchor: { selector: "footer", viewport: { w: 1, h: 1 } },
      }),
    ]);
    const text = formatRetrospective(report, 'for project "wander"');
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("retrospective");
    expect(text).toContain('for project "wander"');
    expect(text).toContain("hit/miss");
    expect(text).toContain("intent");
    expect(text).toContain("blind spots");
    expect(text).toContain("version");
    expect(text).toContain("content-free");
  });

  it("handles the empty set gracefully", () => {
    const text = formatRetrospective(retrospective([]));
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/no feedback/i);
    expect(text).toContain("content-free");
  });
});
