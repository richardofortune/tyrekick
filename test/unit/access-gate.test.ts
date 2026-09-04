// @vitest-environment node
//
// Unit tests for the Cloudflare Pages access gate
// (access-gate/cloudflare-pages/functions/_middleware.js).
//
// Runs under the `node` environment (override above) because the gate uses
// WebCrypto (crypto.subtle) for HMAC session signing, which jsdom does not
// provide. Request/Response/FormData/URLSearchParams/btoa are Node globals.

import { describe, it, expect, vi } from "vitest";
// eslint-disable-next-line
import { onRequest } from "../../access-gate/cloudflare-pages/functions/_middleware.js";

const CODE = "s3cret-window-code";
const SITE = "SITE_BODY_OK";
const ORIGIN = "https://demo.test";

type Env = Record<string, string>;

// The gate calls next() only when access is granted; our stub returns a marker
// response so "reached the site" is observable.
function ctx(request: Request, env: Env = { REVIEW_PASSWORD: CODE }) {
  return { request, env, next: async () => new Response(SITE, { status: 200 }) };
}

function getReq(headers: Record<string, string> = {}, path = "/") {
  return new Request(ORIGIN + path, { method: "GET", headers });
}

function loginReq(fields: Record<string, string>) {
  return new Request(`${ORIGIN}/__tyrekick/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

function cookieFrom(res: Response) {
  const sc = res.headers.get("set-cookie") || "";
  return sc.split(";")[0]; // "tyrekick_review=<token>"
}

async function freshSessionCookie() {
  const res = await onRequest(ctx(loginReq({ code: CODE, next: "/" })));
  return cookieFrom(res);
}

describe("access gate — the window (fail closed / dev bypass)", () => {
  it("fails CLOSED with 503 when no access code is configured", async () => {
    const res = await onRequest(ctx(getReq(), {}));
    expect(res.status).toBe(503);
  });

  it("bypasses entirely when REVIEW_GATE=off (local dev only)", async () => {
    const res = await onRequest(ctx(getReq(), { REVIEW_GATE: "off" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SITE);
  });
});

describe("access gate — login", () => {
  it("serves the Tyrekick login (401, html) and leaks no site content", async () => {
    const res = await onRequest(ctx(getReq()));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Tyrekick");
    expect(html).not.toContain(SITE);
  });

  it("rejects a wrong code with 401", async () => {
    const res = await onRequest(ctx(loginReq({ code: "wrong", next: "/" })));
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("didn't work");
  });

  it("accepts the correct code: 302 + hardened, signed session cookie", async () => {
    const res = await onRequest(ctx(loginReq({ code: CODE, next: "/" })));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const sc = res.headers.get("set-cookie") || "";
    expect(sc).toMatch(/^tyrekick_review=[^;]+/);
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("Secure");
    expect(sc).toContain("SameSite=Lax");
    expect(sc).toContain("Max-Age=43200"); // 12h
  });

  it("guards against open-redirects in the post-login next target", async () => {
    const res = await onRequest(ctx(loginReq({ code: CODE, next: "//evil.example/x" })));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });
});

describe("access gate — sessions", () => {
  it("lets a valid session through to the site", async () => {
    const cookie = await freshSessionCookie();
    const res = await onRequest(ctx(getReq({ cookie })));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SITE);
  });

  it("rejects a tampered/forged cookie with 401", async () => {
    const res = await onRequest(ctx(getReq({ cookie: "tyrekick_review=9999999999999.deadbeef" })));
    expect(res.status).toBe(401);
  });

  it("enforces the 12h expiry server-side, independent of cookie Max-Age", async () => {
    const t0 = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    const cookie = await freshSessionCookie(); // exp = t0 + 12h, signed

    now.mockReturnValue(t0 + 60 * 60 * 1000); // +1h → still valid
    expect((await onRequest(ctx(getReq({ cookie })))).status).toBe(200);

    now.mockReturnValue(t0 + 13 * 60 * 60 * 1000); // +13h → expired
    expect((await onRequest(ctx(getReq({ cookie })))).status).toBe(401);

    now.mockRestore();
  });

  it("invalidates every existing session when the access code is rotated", async () => {
    const cookie = await freshSessionCookie(); // signed with CODE
    const res = await onRequest(ctx(getReq({ cookie }), { REVIEW_PASSWORD: "rotated-code" }));
    expect(res.status).toBe(401);
  });
});
