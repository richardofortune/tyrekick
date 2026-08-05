import { describe, it, expect } from "vitest";
// The CLI helpers are plain Node ESM (zero-dep); import them directly.
import { linkPreview, previewTags, renderStatus, canonicalUrl, ogUrlTag } from "../../bin/lib.mjs";

/** A generated prototype as it usually arrives: a title, and nothing else. */
const bare = `<!doctype html><html><head><title>Trip Planner</title></head><body><h1>Hi</h1></body></html>`;

/** A page whose author already set Open Graph deliberately. */
const authored =
  `<!doctype html><html><head>` +
  `<title>Ignored by the crawler</title>` +
  `<meta property="og:title" content="Trip Planner — checkout">` +
  `<meta property="og:description" content="The new three-step checkout.">` +
  `<meta property="og:image" content="https://example.test/card.png">` +
  `<meta property="og:url" content="https://example.test/">` +
  `</head><body></body></html>`;

describe("linkPreview", () => {
  it("falls back to <title> when there is no og:title, like a crawler does", () => {
    expect(linkPreview(bare).title).toBe("Trip Planner");
  });

  it("prefers og:title over <title>, like a crawler does", () => {
    expect(linkPreview(authored).title).toBe("Trip Planner — checkout");
  });

  it("reads a description from either property= or name=", () => {
    const nameForm = `<head><meta name="description" content="From the name form."></head>`;
    expect(linkPreview(nameForm).description).toBe("From the name form.");
    expect(linkPreview(authored).description).toBe("The new three-step checkout.");
  });

  it("reports a bare page as unusable, and says what is missing", () => {
    const p = linkPreview(bare);
    expect(p.hasOg).toBe(false);
    expect(p.usable).toBe(false);
    expect(p.missing).toContain("description");
    expect(p.missing).toContain("image");
  });

  it("reports an authored page as complete", () => {
    const p = linkPreview(authored);
    expect(p.hasOg).toBe(true);
    expect(p.usable).toBe(true);
    expect(p.missing).toEqual([]);
    expect(p.image).toBe("https://example.test/card.png");
  });

  it("treats an empty content attribute as absent rather than as a value", () => {
    const empty = `<head><title>T</title><meta property="og:description" content="  "></head>`;
    expect(linkPreview(empty).description).toBeNull();
  });

  it("does not mistake a page with no head for one that has tags", () => {
    const p = linkPreview(`<body>nothing here</body>`);
    expect(p.title).toBeNull();
    expect(p.hasOg).toBe(false);
    expect(p.usable).toBe(false);
  });
});

describe("previewTags", () => {
  it("emits the tags a chat client actually reads", () => {
    const out = previewTags({ title: "Trip Planner", description: "Review the checkout." });
    expect(out).toContain(`<meta property="og:title" content="Trip Planner">`);
    expect(out).toContain(`<meta property="og:description" content="Review the checkout.">`);
    expect(out).toContain(`<meta name="twitter:card" content="summary">`);
    expect(out).toContain(`<meta property="og:type" content="website">`);
  });

  it("escapes a title that would otherwise break out of the attribute", () => {
    const out = previewTags({ title: `Ben & Jerry's "beta"`, description: "d" });
    expect(out).toContain("&amp;");
    expect(out).toContain("&quot;");
    expect(out).not.toMatch(/content="[^"]*"[^">]*"/);
  });

  it("round-trips: what it writes is what linkPreview then reads", () => {
    const html = `<head><title>T</title>${previewTags({ title: "Trip Planner", description: "Review it." })}</head>`;
    const p = linkPreview(html);
    expect(p.title).toBe("Trip Planner");
    expect(p.description).toBe("Review it.");
    expect(p.usable).toBe(true);
  });

  it("omits og:url when not told one, and og:image always — init cannot know either", () => {
    const out = previewTags({ title: "T", description: "d" });
    expect(out).not.toContain("og:url");
    expect(out).not.toContain("og:image");
  });

  it("emits og:url when --url supplied it", () => {
    const out = previewTags({ title: "T", description: "d", url: "https://demo.pages.dev/" });
    expect(out).toContain(`<meta property="og:url" content="https://demo.pages.dev/">`);
  });

  it("does not emit a bad og:url — a wrong canonical is worse than none", () => {
    for (const bad of ["not a url", "javascript:alert(1)", "http://localhost:8123/", ""]) {
      expect(previewTags({ title: "T", description: "d", url: bad })).not.toContain("og:url");
    }
  });

  it("round-trips the url: what it writes is what linkPreview then reads", () => {
    const html = `<head>${previewTags({ title: "T", description: "d", url: "demo.pages.dev" })}</head>`;
    expect(linkPreview(html).url).toBe("https://demo.pages.dev/");
  });
});

describe("canonicalUrl", () => {
  it("assumes https for a bare host, because that is how a deploy URL is typed", () => {
    expect(canonicalUrl("demo.pages.dev")).toBe("https://demo.pages.dev/");
  });

  it("keeps an explicit scheme, path and query", () => {
    expect(canonicalUrl("http://demo.test/review?x=1")).toBe("http://demo.test/review?x=1");
  });

  it("drops the fragment, which no crawler canonicalises on", () => {
    expect(canonicalUrl("https://demo.test/page#section")).toBe("https://demo.test/page");
  });

  it("refuses anything a crawler should not be pointed at", () => {
    expect(canonicalUrl("javascript:alert(1)")).toBeNull(); // not a page
    expect(canonicalUrl("file:///tmp/index.html")).toBeNull(); // not fetchable
    expect(canonicalUrl("http://localhost:3000")).toBeNull(); // not shareable
    expect(canonicalUrl("https://user:pw@demo.test/")).toBeNull(); // credentials
    expect(canonicalUrl("   ")).toBeNull();
    expect(canonicalUrl(undefined)).toBeNull();
  });
});

describe("ogUrlTag", () => {
  it("gives just the one line, for a page that already has other og: tags", () => {
    expect(ogUrlTag("demo.pages.dev")).toBe(
      `  <meta property="og:url" content="https://demo.pages.dev/">\n`,
    );
  });

  it("returns null rather than a broken tag", () => {
    expect(ogUrlTag("nonsense")).toBeNull();
  });
});

describe("renderStatus — link preview row", () => {
  const base = {
    widget: { state: "installed", kind: "tag", file: "index.html" },
    cfg: { webhook: "https://demo.workers.dev/feedback" },
    transport: "json",
    worker: true,
    mcp: { registered: false, cliMissing: false, hasToken: false },
    reviewKey: null,
    rateLimit: { found: false },
    secrets: { known: false, names: new Set() },
    project: "p",
  };
  const row = (s: unknown) =>
    renderStatus(s).find((r: string[]) => r[0] === "Link preview")?.[1];

  it("flags a page that would share as a bare URL", () => {
    expect(row({ ...base, preview: linkPreview(bare) })).toMatch(/bare URL/);
  });

  it("distinguishes text-only from a full card", () => {
    const textOnly = `<head><title>T</title><meta property="og:description" content="d"></head>`;
    expect(row({ ...base, preview: linkPreview(textOnly) })).toMatch(/og:image/);
    expect(row({ ...base, preview: linkPreview(authored) })).toMatch(/✔/);
  });

  it("omits the row entirely when there is no page to inspect", () => {
    expect(row({ ...base, preview: null })).toBeUndefined();
  });
});
