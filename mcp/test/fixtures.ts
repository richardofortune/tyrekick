import type { FeedbackRecord } from "../src/client.js";

export function makeRecord(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    schema: 1,
    id: "11111111-1111-4111-8111-111111111111",
    created_at: "2026-07-01T10:00:00.000Z",
    project_name: "Demo App",
    app_version: "v1.2.0",
    route: "/pricing",
    url: "https://demo.example.com/pricing",
    body: "The CTA button overlaps the footer on mobile",
    reviewer_name: "Jane",
    session_id: "22222222-2222-4222-8222-222222222222",
    anchor: {
      x_pct: 51.3,
      y_pct: 88.9,
      selector: "main > section.cta > button",
      viewport: { w: 390, h: 844 },
    },
    env: { user_agent: "Mozilla/5.0 (test)", language: "en-NZ" },
    status: "open",
    received_at: "2026-07-01T10:00:01.000Z",
    resolved_at: null,
    resolution_note: null,
    ...overrides,
  };
}

/** A schema v2 record: v1 base plus element/context/env extensions/page_errors. */
export function makeV2Record(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return makeRecord({
    schema: 2,
    anchor: {
      x_pct: 51.3,
      y_pct: 88.9,
      selector: "main > section.cta > button",
      viewport: { w: 390, h: 844 },
      element: {
        tag: "button",
        id: null,
        testid: "find-trips",
        role: "button",
        text: "Find trips",
        label: null,
        rect: { x: 12, y: 640, w: 160, h: 44 },
      },
      context: { heading: "Your itinerary", landmark: "main > section#pricing" },
    },
    env: {
      user_agent: "Mozilla/5.0 (test)",
      language: "en-NZ",
      screen: { w: 390, h: 844 },
      dpr: 3,
      dark: true,
      touch: true,
    },
    page_errors: [
      "TypeError: Cannot read properties of undefined (reading 'trips')",
      "Unhandled rejection: fetch failed",
    ],
    ...overrides,
  });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
