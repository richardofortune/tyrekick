/**
 * Delivery. POST with an 8s AbortController timeout and exactly one retry after
 * a 2s backoff. Never throws and never leaves an unhandled rejection — always
 * resolves to a typed { ok } result the composer switches on.
 */
import type { FeedbackPayload, Transport } from "../types";

export interface SendResult {
  ok: boolean;
  /** The destination's snake_case failure reason, when it sent a readable one. */
  error?: string;
}

const TIMEOUT_MS = 8000;
const RETRY_MS = 2000;

export async function send(
  webhook: string,
  transport: Transport,
  payload: FeedbackPayload,
): Promise<SendResult> {
  const first = await once(webhook, transport, payload);
  // A closed review is a deterministic refusal — retrying only makes the
  // reviewer wait 2s to be told no twice.
  if (first.ok || first.error === "review_closed") return first;
  await delay(RETRY_MS);
  return once(webhook, transport, payload);
}

async function once(
  webhook: string,
  transport: Transport,
  payload: FeedbackPayload,
): Promise<SendResult> {
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
    if (transport === "discord") return { ok: res.ok }; // 2xx (Discord: 204) is enough
    // json: read the body even on a non-2xx — that is where the reason lives.
    let text = "";
    try {
      text = await res.text();
    } catch {
      return { ok: res.ok };
    }
    let parsed: { ok?: unknown; error?: unknown } | null = null;
    try {
      parsed = text ? (JSON.parse(text) as { ok?: unknown; error?: unknown }) : null;
    } catch {
      /* non-JSON body — judge on status alone */
    }
    const error = parsed && typeof parsed.error === "string" ? parsed.error : undefined;
    if (!res.ok || (parsed && parsed.ok === false)) return { ok: false, error };
    return { ok: true };
  } catch {
    return { ok: false }; // timeout / abort / network error
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
