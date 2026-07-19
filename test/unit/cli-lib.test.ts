import { describe, it, expect } from "vitest";
// The CLI helpers are plain Node ESM (zero-dep); import them directly.
import { stripTag, parseConfig, isEsmMount, parseEsmConfig } from "../../bin/lib.mjs";

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
