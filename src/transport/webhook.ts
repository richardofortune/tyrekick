/**
 * Delivery. POST with an 8s AbortController timeout and exactly one retry after
 * a 2s backoff. Never throws and never leaves an unhandled rejection — always
 * resolves to a typed { ok } result the composer switches on.
 */
import type { FeedbackPayload, Transport } from "../types";

export interface SendResult {
  ok: boolean;
}

const TIMEOUT_MS = 8000;
const RETRY_MS = 2000;

export async function send(
  webhook: string,
  transport: Transport,
  payload: FeedbackPayload,
): Promise<SendResult> {
  if (await once(webhook, transport, payload)) return { ok: true };
  await delay(RETRY_MS);
  return { ok: await once(webhook, transport, payload) };
}

async function once(
  webhook: string,
  transport: Transport,
  payload: FeedbackPayload,
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const body =
      transport === "discord"
        ? JSON.stringify({ content: discordMessage(payload) })
        : JSON.stringify(payload);
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) return false;
    if (transport === "discord") return true; // 2xx (Discord: 204) is enough
    // json: success unless the body explicitly says { "ok": false }
    let text = "";
    try {
      text = await res.text();
    } catch {
      return true;
    }
    if (!text) return true;
    try {
      const parsed = JSON.parse(text) as { ok?: unknown } | null;
      if (parsed && parsed.ok === false) return false;
    } catch {
      /* non-JSON 2xx body — treat as success */
    }
    return true;
  } catch {
    return false; // timeout / abort / network error
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Human-readable single-line Discord message. */
export function discordMessage(p: FeedbackPayload): string {
  const who = p.reviewer_name || "Anonymous";
  const anchor = p.anchor.selector
    ? p.anchor.selector
    : p.anchor.x_pct + "%, " + p.anchor.y_pct + "%";
  return (
    "**" + p.project_name + " " + p.app_version + "** — " + who + "\n" +
    p.body + "\n" +
    anchor + " · <" + p.url + ">"
  );
}
