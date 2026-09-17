// @vitest-environment node
/**
 * Page gate (a Worker in front of static assets): one shared password in front
 * of a hosted prototype. Gates VIEWING the page; the feedback worker and the review
 * key are untouched by it.
 */
import { describe, it, expect } from "vitest";
import gate from "../../destinations/cloudflare/pages-gate.js";

const INDEX = `<!doctype html><html><head><title>Trip planner</title>
<meta property="og:title" content="Trip planner">
<meta property="og:description" content="Review it and pin your comments.">
<meta property="og:url" content="https://trip.acct.workers.dev/">
</head><body><h1>Secret prototype</h1></body></html>`;

const ASSETS = {
  async fetch(req: Request) {
    const p = new URL(req.url).pathname;
    if (p === "/" || p === "/index.html") return new Response(INDEX, { headers: { "content-type": "text/html" } });
    if (p === "/app.js") return new Response("console.log(1)", { headers: { "content-type": "text/javascript" } });
    return new Response("nope", { status: 404 });
  },
};
const env = (password?: string) => ({ ASSETS, PAGE_PASSWORD: password });
const get = (path = "/", cookie?: string) =>
  new Request(`https://trip.acct.workers.dev${path}`, { headers: cookie ? { cookie } : {} });
const login = (password: string, path = "/") =>
  new Request(`https://trip.acct.workers.dev${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tyrekick_password: password }),
  });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") || "").split(";")[0];

describe("pages gate", () => {
  it("serves the login page, not the prototype, without a cookie", async () => {
    const res = await gate.fetch(get("/"), env("hunter2"));
    const body = await res.text();
    expect(body).toContain('name="tyrekick_password"');
    expect(body).not.toContain("Secret prototype");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps the og tags on the login page so a shared link still unfurls", async () => {
    const res = await gate.fetch(get("/"), env("hunter2"));
    // Unfurl bots skip non-2xx responses, so the login page is a 200.
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<meta property="og:title" content="Trip planner">');
    expect(body).toContain("<title>Trip planner</title>");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("gates every path, not just html", async () => {
    const res = await gate.fetch(get("/app.js"), env("hunter2"));
    expect(await res.text()).not.toContain("console.log");
  });

  it("right password sets a cookie and redirects back; the cookie then opens the page", async () => {
    const res = await gate.fetch(login("hunter2", "/deep/page.html"), env("hunter2"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://trip.acct.workers.dev/deep/page.html");
    const sc = res.headers.get("set-cookie") || "";
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/Secure/);
    expect(sc).toMatch(/SameSite=Lax/);
    expect(sc).toMatch(/Path=\//);

    const page = await gate.fetch(get("/", cookieOf(res)), env("hunter2"));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Secret prototype");
  });

  it("wrong password gets the login page again with an error, and no cookie", async () => {
    const res = await gate.fetch(login("nope"), env("hunter2"));
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toMatch(/wrong password/i);
  });

  it("a forged or stale cookie does not open the page", async () => {
    const forged = await gate.fetch(get("/", "tyrekick_gate=deadbeef"), env("hunter2"));
    expect(await forged.text()).not.toContain("Secret prototype");
    // Rotating the password invalidates every cookie minted under the old one.
    const old = await gate.fetch(login("hunter2"), env("hunter2"));
    const after = await gate.fetch(get("/", cookieOf(old)), env("hunter3"));
    expect(await after.text()).not.toContain("Secret prototype");
  });

  it("fails closed when PAGE_PASSWORD is not set", async () => {
    const res = await gate.fetch(get("/"), env(undefined));
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/PAGE_PASSWORD/);
    expect(await (await gate.fetch(login(""), env(undefined))).text()).not.toContain("Secret prototype");
  });

  it("does not misread an app's own form POST as a login attempt", async () => {
    const req = new Request("https://trip.acct.workers.dev/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "a@b.c" }),
    });
    const res = await gate.fetch(req, env("hunter2"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="tyrekick_password"');
  });
});
