/**
 * Tyrekick page gate — one shared password in front of a static site on
 * Cloudflare Workers.
 *
 * `npx tyrekick lock` copies this file to `tyrekick-gate.js` and makes it the
 * Worker's `main`, with `assets.run_worker_first` so every request comes here
 * first. It serves the static files (`env.ASSETS`) only to a browser that has
 * typed the password. It gates VIEWING the prototype; it never touches the
 * feedback worker, the review key, or what reviewers can do once they are in.
 *
 * Password: a Worker secret named PAGE_PASSWORD (never in this file, never in
 * page source). Not set = fails closed with a 503, never open by accident.
 *
 *     printf '%s' "$PW" | npx wrangler secret put PAGE_PASSWORD
 *
 * Session: a cookie holding an HMAC keyed on the password. No store, no
 * sessions to expire; change the password and every cookie stops working.
 *
 * Link previews: the login page carries the `og:` tags and <title> of the
 * page asked for, and answers 200 (unfurl bots drop non-2xx), so a shared
 * link still shows what it is. It is `noindex`, so search engines leave it.
 */

const COOKIE = "tyrekick_gate";
const FIELD = "tyrekick_password";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days; re-typed after that

const enc = new TextEncoder();

/** HMAC-SHA256 of a fixed message, keyed on the password: the cookie value. */
async function token(password) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("tyrekick-page-gate-v1"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare, so a wrong guess costs the same as a near miss. */
function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookie(request) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]+)`));
  return m ? m[1] : null;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * <title> and og: tags of the page being asked for (falling back to /), so the
 * login page unfurls the way the prototype would. Whole self-contained <meta>
 * tags only; nothing else from the page reaches the login screen.
 */
async function preview(request, env) {
  for (const url of [request.url, new URL("/", request.url).href]) {
    try {
      const res = await env.ASSETS.fetch(new Request(url));
      if (!res.ok || !(res.headers.get("content-type") || "").includes("text/html")) continue;
      const html = await res.text();
      return {
        title: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || "",
        og: (html.match(/<meta\s+[^>]*property="og:[a-z_:]+"[^>]*>/gi) || []).join("\n"),
      };
    } catch {
      /* try the next candidate */
    }
  }
  return { title: "", og: "" };
}

function page(status, { title, og = "", body, headers = {} }) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${og}
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#f6f6f4;color:#1a1a1a}
  form,main{width:min(22rem,90vw);padding:2rem;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
  h1{font-size:1.1rem;margin:0 0 .25rem}p{margin:.25rem 0 1rem;color:#555}
  input,button{width:100%;box-sizing:border-box;font:inherit;padding:.6rem .7rem;border-radius:8px;border:1px solid #ccc}
  button{margin-top:.6rem;background:#1a1a1a;color:#fff;border-color:#1a1a1a;cursor:pointer}
  .err{color:#b3261e}
</style></head><body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", ...headers },
  });
}

async function loginPage(request, env, { wrong = false } = {}) {
  const pv = await preview(request, env);
  const title = pv.title || "Password required";
  return page(200, {
    title,
    og: pv.og,
    body: `<form method="post" autocomplete="off">
  <h1>${esc(title)}</h1>
  <p>This prototype is password protected.</p>
  ${wrong ? `<p class="err">Wrong password, try again.</p>` : ""}
  <label for="pw" style="display:block;font-size:.9rem;margin-bottom:.3rem">Password</label>
  <input id="pw" name="${FIELD}" type="password" required autofocus>
  <button type="submit">Open</button>
</form>`,
  });
}

export default {
  async fetch(request, env) {
    const password = env.PAGE_PASSWORD;
    if (!password) {
      return page(503, {
        title: "Locked",
        body: `<main><h1>Locked, but no password is set</h1><p>Set the <code>PAGE_PASSWORD</code> secret on this Worker (<code>npx tyrekick lock</code>), or <code>npx tyrekick unlock</code> to open it.</p></main>`,
      });
    }
    const expected = await token(password);

    if (request.method === "POST" && (request.headers.get("content-type") || "").includes("application/x-www-form-urlencoded")) {
      const given = (await request.formData()).get(FIELD);
      if (typeof given === "string") {
        if (same(await token(given), expected)) {
          return new Response(null, {
            status: 303,
            headers: {
              location: request.url,
              "set-cookie": `${COOKIE}=${expected}; Max-Age=${MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`,
              "cache-control": "no-store",
            },
          });
        }
        return loginPage(request, env, { wrong: true });
      }
    }

    if (same(cookie(request), expected)) return env.ASSETS.fetch(request);
    return loginPage(request, env);
  },
};
