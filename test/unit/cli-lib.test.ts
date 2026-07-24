import { describe, it, expect } from "vitest";
// The CLI helpers are plain Node ESM (zero-dep); import them directly.
import {
  stripTag,
  parseConfig,
  isEsmMount,
  parseEsmConfig,
  parseRateLimit,
  renderStatus,
  readinessNote,
} from "../../bin/lib.mjs";

// The exact block `tyrekick init` injects (worker/json transport).
const jsonBlock =
  `  <!-- Tyrekick: reviewers pin feedback; agents pull it back (github.com/richardofortune/tyrekick) -->\n` +
  `  <script src="https://cdn.jsdelivr.net/npm/tyrekick@0.3/dist/tyrekick.js"\n` +
  `          data-webhook="https://demo.workers.dev/feedback"\n` +
  `          data-project-name="my-proto"\n` +
  `          data-app-version="v0.1"></script>\n`;

// The discord variant carries an extra data-transport line.
const discordBlock =
  `  <!-- Tyrekick: reviewers pin feedback; agents pull it back (github.com/richardofortune/tyrekick) -->\n` +
  `  <script src="https://cdn.jsdelivr.net/npm/tyrekick@0.3/dist/tyrekick.js"\n` +
  `          data-webhook="https://discord.com/api/webhooks/1/abc"\n` +
  `          data-transport="discord"\n` +
  `          data-project-name="my-proto"\n` +
  `          data-app-version="v0.1"></script>\n`;

const page = (block: string) =>
  `<!doctype html>\n<html><head><title>x</title></head>\n<body>\n  <h1>hi</h1>\n${block}</body></html>\n`;

describe("parseConfig", () => {
  it("extracts webhook, project, and version; defaults transport to json", () => {
    const c = parseConfig(jsonBlock);
    expect(c.webhook).toBe("https://demo.workers.dev/feedback");
    expect(c.project).toBe("my-proto");
    expect(c.appVersion).toBe("v0.1");
    expect(c.transport).toBe("json");
  });

  it("reads data-transport when present", () => {
    expect(parseConfig(discordBlock).transport).toBe("discord");
  });

  it("returns an empty object for a null block", () => {
    expect(parseConfig(null)).toEqual({});
  });
});

describe("stripTag", () => {
  it("removes the injected json block and returns it", () => {
    const html = page(jsonBlock);
    const { html: out, block } = stripTag(html);
    expect(block).toBe(jsonBlock);
    expect(out).not.toContain("tyrekick");
    expect(out).toContain("<h1>hi</h1>");
    expect(out).toContain("</body>");
  });

  it("also matches the discord variant", () => {
    const { block } = stripTag(page(discordBlock));
    expect(block).toBe(discordBlock);
  });

  it("returns block=null when there is no tag", () => {
    const clean = page("");
    const { html, block } = stripTag(clean);
    expect(block).toBeNull();
    expect(html).toBe(clean);
  });

  // The disable -> enable contract: stripping then re-inserting the returned
  // block before </body> must reproduce the original page byte-for-byte.
  it("round-trips: strip then restore reproduces the original", () => {
    for (const block of [jsonBlock, discordBlock]) {
      const original = page(block);
      const { html, block: removed } = stripTag(original);
      const restored = html.replace("</body>", `${removed}</body>`);
      expect(restored).toBe(original);
    }
  });
});

// The issue-#7 framework install: `import { init } from "tyrekick"` + init({...}).
const esmMount = `"use client"
import { useEffect } from "react"
export function TyrekickWidget() {
  useEffect(() => {
    import("tyrekick").then(({ init }) => {
      init({
        webhook: "https://demo.workers.dev/feedback",
        projectName: "my-next-app",
        appVersion: "1.2.0",
      })
    })
  }, [])
  return null
}
`;

describe("isEsmMount", () => {
  it("matches a dynamic import + init() mount", () => {
    expect(isEsmMount(esmMount)).toBe(true);
  });

  it("matches a static import mount", () => {
    expect(isEsmMount(`import { init } from "tyrekick";\ninit({ webhook: "x", appVersion: "1" });`)).toBe(true);
  });

  it("does not match a file that merely mentions tyrekick", () => {
    expect(isEsmMount(`export const note = "we use tyrekick for feedback";`)).toBe(false);
  });

  it("does not match a component that only renders <TyrekickWidget/> (no import/init)", () => {
    expect(isEsmMount(`import { TyrekickWidget } from "./TyrekickWidget";\nexport default () => <TyrekickWidget/>;`)).toBe(false);
  });
});

describe("parseEsmConfig", () => {
  it("extracts config from the init({...}) argument", () => {
    const c = parseEsmConfig(esmMount);
    expect(c.webhook).toBe("https://demo.workers.dev/feedback");
    expect(c.project).toBe("my-next-app");
    expect(c.appVersion).toBe("1.2.0");
    expect(c.transport).toBe("json");
  });

  it("reads an explicit transport when present", () => {
    expect(parseEsmConfig(`init({ webhook: "x", appVersion: "1", transport: "discord" })`).transport).toBe("discord");
  });
});

// --- public-share posture (the `status` doctor) ---------------------------

describe("reviewKey detection", () => {
  it("reads data-review-key from a script tag", () => {
    const block =
      `  <script src="https://cdn/tyrekick.js"\n` +
      `          data-webhook="https://demo.workers.dev/feedback"\n` +
      `          data-review-key="rk-secret"></script>\n`;
    expect(parseConfig(block).reviewKey).toBe("rk-secret");
  });

  it("is null when the widget carries no review key", () => {
    expect(parseConfig(jsonBlock).reviewKey).toBeNull();
  });

  it("reads reviewKey from an ESM init()", () => {
    expect(parseEsmConfig(`init({ webhook: "x", appVersion: "1", reviewKey: "rk-esm" })`).reviewKey).toBe("rk-esm");
  });
});

describe("parseRateLimit", () => {
  const unsafeForm = `
[[unsafe.bindings]]
name = "INGEST_LIMITER"
type = "ratelimit"
namespace_id = "1001"
simple = { limit = 15, period = 60 }

[[unsafe.bindings]]
name = "READ_LIMITER"
type = "ratelimit"
namespace_id = "1002"
simple = { limit = 120, period = 60 }
`;

  it("parses both limiters from the [[unsafe.bindings]] form", () => {
    const r = parseRateLimit(unsafeForm);
    expect(r.configured).toBe(true);
    expect(r.ingest).toEqual({ limit: 15, period: 60 });
    expect(r.read).toEqual({ limit: 120, period: 60 });
  });

  it("also parses the modern [[ratelimit]] form (binding = …)", () => {
    const modern = `
[[ratelimit]]
binding = "INGEST_LIMITER"
namespace_id = "1001"
simple = { limit = 30, period = 10 }
`;
    const r = parseRateLimit(modern);
    expect(r.ingest).toEqual({ limit: 30, period: 10 });
    expect(r.configured).toBe(true);
  });

  it("reports off when no limiter bindings are present", () => {
    const r = parseRateLimit(`name = "tyrekick-demo"\n[[kv_namespaces]]\nbinding = "FEEDBACK"\n`);
    expect(r.configured).toBe(false);
    expect(r.ingest).toBeNull();
    expect(r.read).toBeNull();
  });
});

// Minimal status object for the pure renderers.
function makeStatus(over: Record<string, unknown> = {}) {
  return {
    widget: { state: "installed", kind: "tag", file: "index.html" },
    cfg: { webhook: "https://demo.workers.dev/feedback" },
    transport: "json",
    worker: true,
    mcp: { registered: true, hasToken: true, cliMissing: false },
    reviewKey: null,
    rateLimit: { found: false, configured: false, ingest: null, read: null },
    secrets: { known: false, names: new Set() },
    project: "demo",
    ...over,
  } as never;
}

describe("renderStatus — public-share rows", () => {
  const text = (s: unknown) =>
    renderStatus(s as never)
      .map((r: string[]) => r.join("  "))
      .join("\n");

  it("shows shared review OFF and a rate-limit + AI-reply picture when all set", () => {
    const out = text(
      makeStatus({
        rateLimit: { found: true, configured: true, ingest: { limit: 15, period: 60 }, read: { limit: 120, period: 60 } },
        secrets: { known: true, names: new Set(["ANTHROPIC_API_KEY"]) },
      }),
    );
    expect(out).toMatch(/Shared review\s+off/);
    expect(out).toMatch(/Rate limit\s+✔ on — 15\/60s ingest, 120\/60s read/);
    expect(out).toMatch(/AI reply\s+✔ on/);
  });

  it("warns when shared review is ON", () => {
    expect(text(makeStatus({ reviewKey: "rk" }))).toMatch(/Shared review.*⚠ ON — anyone with the link/);
  });

  it("flags a rate limit that is present-but-off", () => {
    expect(text(makeStatus({ rateLimit: { found: true, configured: false, ingest: null, read: null } }))).toMatch(
      /Rate limit\s+✗ off/,
    );
  });

  it("flags a widget key with no matching worker secret", () => {
    const out = text(makeStatus({ reviewKey: "rk", secrets: { known: true, names: new Set() } }));
    expect(out).toMatch(/worker has none — \/shared will 401/);
  });

  it("omits worker-side rows entirely on the discord transport", () => {
    const out = text(makeStatus({ transport: "discord", cfg: { webhook: "https://discord.com/api/webhooks/1/a" } }));
    expect(out).not.toMatch(/Shared review|Rate limit|AI reply/);
  });
});

describe("readinessNote", () => {
  it("returns null when nothing needs flagging", () => {
    expect(readinessNote(makeStatus())).toBeNull();
  });

  it("flags shared review on", () => {
    expect(readinessNote(makeStatus({ reviewKey: "rk" }))).toMatch(/shared review is ON/);
  });

  it("flags missing rate limiting", () => {
    expect(readinessNote(makeStatus({ rateLimit: { found: true, configured: false } }))).toMatch(/no rate limiting/);
  });

  it("reminds about the spend limit when AI reply is on", () => {
    expect(readinessNote(makeStatus({ secrets: { known: true, names: new Set(["ANTHROPIC_API_KEY"]) } }))).toMatch(
      /spend limit/,
    );
  });

  it("flags the dangerous shared-review + AI-reply combination", () => {
    const note = readinessNote(
      makeStatus({ reviewKey: "rk", secrets: { known: true, names: new Set(["ANTHROPIC_API_KEY"]) } }),
    );
    expect(note).toMatch(/BOTH on/);
    expect(note).toMatch(/read the thread/);
    // The combined warning replaces the standalone shared-review line (no redundancy).
    expect(note).not.toMatch(/only for a private link/);
  });

  it("says nothing for the discord transport", () => {
    expect(readinessNote(makeStatus({ transport: "discord" }))).toBeNull();
  });
});
