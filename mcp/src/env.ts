/**
 * Environment validation for the Tyrekick MCP server.
 * Both variables are required; empty strings count as missing.
 */

export interface TyrekickEnv {
  url: string;
  token: string;
}

export type EnvResult = { ok: true; env: TyrekickEnv } | { ok: false; error: string };

export function validateEnv(env: Record<string, string | undefined>): EnvResult {
  const url = (env.TYREKICK_URL ?? "").trim();
  const token = (env.TYREKICK_TOKEN ?? "").trim();

  const missing: string[] = [];
  if (!url) missing.push("TYREKICK_URL");
  if (!token) missing.push("TYREKICK_TOKEN");

  if (missing.length > 0) {
    return {
      ok: false,
      error: [
        `tyrekick-mcp: missing required environment variable(s): ${missing.join(", ")}`,
        "",
        "  TYREKICK_URL   — base URL of your Tyrekick Cloudflare Worker",
        "                   (e.g. https://tyrekick-feedback.<you>.workers.dev)",
        "  TYREKICK_TOKEN — the management token you set with `wrangler secret put TYREKICK_TOKEN`",
        "",
        "Example:",
        "  claude mcp add tyrekick --env TYREKICK_URL=https://... --env TYREKICK_TOKEN=... -- npx tyrekick-mcp",
      ].join("\n"),
    };
  }

  return { ok: true, env: { url: url.replace(/\/+$/, ""), token } };
}
