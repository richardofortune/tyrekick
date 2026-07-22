// Tyrekick review access gate — Cloudflare Pages Function (edge-enforced).
//
// Drop this file at `functions/_middleware.js` in the Pages project that serves
// your prototype. It puts a consistent, Tyrekick-branded access screen in front
// of the whole site — deliberately NOT styled like the prototype behind it, so
// reviewers never confuse the review scaffolding with the product itself.
//
// It runs at the edge, before any page or asset is served, so nothing behind it
// (including the embedded tyrekick review key and reviewers' comments) is
// returned until the caller is authenticated.
//
// Model — ephemeral review windows, one shared access code:
//   - Open / rotate a window:  set REVIEW_PASSWORD, then deploy.
//   - Close a window:          delete REVIEW_PASSWORD, then deploy (→ 503).
//   - Fails CLOSED: no code configured ⇒ nobody gets in.
//   - Rotating the code invalidates every existing session (it is the HMAC key).
//
// Two clocks (see docs/access-gate.md for the full model):
//   - WINDOW  = the whole review period; a property of REVIEW_PASSWORD, shared by
//               everyone; opens/closes only when you set/remove the code.
//   - SESSION = one reviewer's logged-in state; a signed cookie, 12h, per browser.
//
// Config (Pages env, production):
//   REVIEW_PASSWORD  (required)  shared access code for the current window
//   REVIEW_PROJECT   (optional)  small label shown on the access screen
//   REVIEW_GATE      (optional)  "off" disables the gate — LOCAL DEV ONLY, set via
//                                a local .dev.vars file (never deployed)

const LOGIN_PATH = "/__tyrekick/login";
const COOKIE = "tyrekick_review";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // Local-dev escape hatch (only ever set via local .dev.vars, never deployed).
  if ((env.REVIEW_GATE || "").toLowerCase() === "off") return next();

  const code = env.REVIEW_PASSWORD;
  // Fail closed: no access code ⇒ the window is closed for everyone.
  if (!code) {
    return new Response("This review window is closed.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // Handle a login submission.
  if (request.method === "POST" && url.pathname === LOGIN_PATH) {
    let submitted = "";
    let nextPath = "/";
    try {
      const form = await request.formData();
      submitted = String(form.get("code") || "");
      nextPath = safePath(form.get("next"));
    } catch {
      /* malformed body → treated as an empty submission */
    }

    if (await constantTimeEqual(submitted, code)) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: nextPath,
          "Set-Cookie": await makeSessionCookie(code),
          "Cache-Control": "no-store",
        },
      });
    }
    return loginResponse(env, nextPath, true);
  }

  // Valid session cookie ⇒ serve the site.
  if (await hasValidSession(request, code)) return next();

  // Otherwise show the branded access screen.
  return loginResponse(env, url.pathname + url.search, false);
}

/* ---------- session token (signed, self-contained) ---------------------- */

async function makeSessionCookie(code) {
  const exp = Date.now() + SESSION_TTL_MS;
  const sig = b64url(await hmac(code, String(exp)));
  const token = `${exp}.${sig}`;
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

async function hasValidSession(request, code) {
  const cookie = (request.headers.get("Cookie") || "")
    .split(/;\s*/)
    .find((c) => c.startsWith(`${COOKIE}=`));
  if (!cookie) return false;
  const token = cookie.slice(COOKIE.length + 1);
  const dot = token.indexOf(".");
  if (dot === -1) return false;

  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;

  const expected = b64url(await hmac(code, String(exp)));
  return timingSafeEqual(bytesOf(sig), bytesOf(expected));
}

/* ---------- crypto helpers ---------------------------------------------- */

async function hmac(keyStr, msgStr) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyStr),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msgStr));
  return new Uint8Array(sig);
}

async function sha256(str) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return new Uint8Array(d);
}

// Compare two secrets without leaking length or match position (hash first).
async function constantTimeEqual(a, b) {
  return timingSafeEqual(await sha256(a), await sha256(b));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function b64url(bytes) {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesOf(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

// Only allow same-origin absolute paths as a redirect target (no open redirect).
function safePath(value) {
  const p = String(value || "/");
  return p.startsWith("/") && !p.startsWith("//") ? p : "/";
}

/* ---------- the Tyrekick-branded access screen -------------------------- */

function loginResponse(env, nextPath, isError) {
  const project = (env.REVIEW_PROJECT || "").trim();
  return new Response(loginHtml(project, nextPath, isError), {
    status: 401,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function loginHtml(project, nextPath, isError) {
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
    );
  const projectLine = project
    ? `<p class="project">${esc(project)}</p>`
    : `<p class="project">Private review</p>`;
  const errorLine = isError
    ? `<p class="err" role="alert">That access code didn't work. Try again.</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Tyrekick — Private review</title>
<style>
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
  :root{
    --bg:#0e0f12; --panel:#16181d; --line:#262a31;
    --ink:#f3f4f6; --ink-soft:#9aa0ab;
    --gold:#ffc53d; --gold-ink:#1a1206;
    --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  }
  body{
    min-height:100dvh;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(1200px 600px at 50% -10%,#1b1d23 0%,var(--bg) 60%);
    color:var(--ink);font-family:var(--font);padding:1.5rem;line-height:1.55;
  }
  .card{
    width:100%;max-width:23rem;background:var(--panel);
    border:1px solid var(--line);border-radius:16px;
    padding:2rem 1.75rem;box-shadow:0 24px 60px rgba(0,0,0,.45);
  }
  .brand{display:flex;align-items:center;gap:.55rem;font-weight:800;
    letter-spacing:.02em;font-size:1.15rem}
  .dot{width:.7rem;height:.7rem;border-radius:50%;background:var(--gold);
    box-shadow:0 0 0 4px rgba(255,197,61,.16)}
  .project{margin-top:.15rem;color:var(--ink-soft);font-size:.8rem;
    text-transform:uppercase;letter-spacing:.14em;font-weight:600}
  .msg{margin:1.4rem 0 1.1rem;color:var(--ink-soft);font-size:.95rem}
  label{display:block;font-size:.72rem;font-weight:700;letter-spacing:.12em;
    text-transform:uppercase;color:var(--ink-soft);margin-bottom:.4rem}
  input{width:100%;font:inherit;font-size:1rem;color:var(--ink);
    background:#0f1116;border:1px solid var(--line);border-radius:10px;
    padding:.7rem .85rem}
  input:focus-visible{outline:none;border-color:var(--gold);
    box-shadow:0 0 0 3px rgba(255,197,61,.2)}
  button{width:100%;margin-top:.9rem;font:inherit;font-weight:800;font-size:1rem;
    color:var(--gold-ink);background:var(--gold);border:none;border-radius:10px;
    padding:.75rem 1rem;cursor:pointer;transition:transform .1s ease}
  button:hover{transform:translateY(-1px)}
  button:focus-visible{outline:3px solid var(--gold);outline-offset:2px}
  .err{margin-bottom:.9rem;color:#ff8a6b;font-size:.9rem;font-weight:600}
  .foot{margin-top:1.5rem;color:var(--ink-soft);font-size:.78rem;
    display:flex;justify-content:space-between;gap:1rem}
  @media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
  <main class="card">
    <div class="brand"><span class="dot" aria-hidden="true"></span> Tyrekick</div>
    ${projectLine}
    <p class="msg">This prototype is being reviewed privately. Enter the access code to continue.</p>
    <form method="POST" action="${esc(LOGIN_PATH)}">
      ${errorLine}
      <input type="hidden" name="next" value="${esc(nextPath)}">
      <label for="code">Access code</label>
      <input id="code" name="code" type="password" autocomplete="current-password"
             autofocus required placeholder="Enter this window's code">
      <button type="submit">Enter &rarr;</button>
    </form>
    <div class="foot">
      <span>Review gate</span>
      <span>Built by Frontier Operations</span>
    </div>
  </main>
</body>
</html>`;
}
