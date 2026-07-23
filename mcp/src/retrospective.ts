/**
 * Retrospective analyzer — the "AI feedback loop" brain.
 *
 * Reads a builder's own feedback + resolution history and reports:
 *   - what reviewers keep flagging (intent buckets),
 *   - what the coding agent did about it (resolved / declined / open — the hit/miss axis),
 *   - recurring blind spots (the same spot flagged repeatedly),
 *   - volume by version.
 *
 * Runs entirely at the edge on the builder's own worker. `classifyIntent` is a
 * DETERMINISTIC keyword matcher (no LLM).
 *
 * CONTENT-FREE GUARANTEE (load-bearing — it's the business model's seam):
 * `report.aggregate` holds ONLY numbers and label strings (intent names, version
 * strings). It never contains a comment body or a reviewer name, so it is the one
 * slice of a retrospective that may safely leave for a central fleet view.
 */

import type { FeedbackRecord } from "./client.js";

export type Intent =
  | "bug"
  | "copy"
  | "a11y"
  | "layout"
  | "data"
  | "request"
  | "question"
  | "praise"
  | "other";

export interface RetroReport {
  total: number;
  /** earliest / latest created_at (ISO), or null when none present. */
  window: { from: string | null; to: string | null };
  outcomes: {
    resolved: number;
    declined: number;
    open: number;
    resolveRate: number;
    declineRate: number;
    openRate: number;
  };
  intents: Array<{
    intent: Intent;
    count: number;
    resolved: number;
    declined: number;
    open: number;
  }>;
  blindSpots: Array<{
    where: string;
    count: number;
    intents: Intent[];
    examples: string[];
  }>;
  byVersion: Array<{ version: string; count: number }>;
  /**
   * CONTENT-FREE — numbers + labels ONLY. NO comment body text, NO reviewer
   * names. The ONLY thing that may ever leave for a central fleet view.
   */
  aggregate: {
    total: number;
    outcomes: { resolved: number; declined: number; open: number };
    intents: Record<string, number>;
    versions: Record<string, number>;
    blindSpotCount: number;
  };
}

type Outcome = "resolved" | "declined" | "open";

// ── keyword sets ───────────────────────────────────────────────────────────

const RE_BUG =
  /\b(broken|does ?n['’]?t work|not working|doesn['’]?t|error|crash|fail|bug|nothing happens|can['’]?t (click|find)|won['’]?t)\b/i;
const RE_A11Y =
  /\b(contrast|screen ?reader|aria|keyboard|accessib|alt text|focus ring|tab order)\b/i;
const RE_DATA =
  /\b(wrong (number|price|date|total|value)|incorrect|miscalculat|calculation|off by)\b/i;
const RE_LAYOUT =
  /\b(align|spacing|margin|padding|overlap|cut ?off|responsive|mobile|layout|too (big|small|wide|narrow)|position|off.?screen)\b/i;
const RE_COPY =
  /\b(typo|wording|copy|grammar|spelling|rename|label|unclear|confusing|misspell)\b/i;
const RE_REQUEST =
  /\b(add|could you|can you|please|would be (nice|good|great)|feature|wish|want|need (a|an|to)|suggest|it['’]d be)\b/i;
const RE_QUESTION_START = /^(what|how|why|where|when|is this|does this|should)\b/i;
const RE_PRAISE = /\b(love|great|nice|good job|looks good|perfect|awesome)\b/i;
const PRAISE_EMOJI = /[\u{1F44D}\u{1F389}]/u; // 👍 🎉

/** Map a record's status onto the hit/miss axis. */
export function outcomeOf(record: FeedbackRecord): Outcome {
  const s = (record.status ?? "").toLowerCase();
  if (s === "resolved") return "resolved";
  if (s === "declined") return "declined";
  return "open"; // "open", "approved", missing, anything else
}

/**
 * DETERMINISTIC intent classification over `record.body` (case-insensitive).
 * A record with page_errors present is always "bug". First hit wins in order:
 * bug → a11y → data → layout → copy → request → question → praise → other.
 */
export function classifyIntent(record: FeedbackRecord): Intent {
  if (Array.isArray(record.page_errors) && record.page_errors.length > 0) return "bug";

  const body = (record.body ?? "").trim();
  if (!body) return "other";

  if (RE_BUG.test(body)) return "bug";
  if (RE_A11Y.test(body)) return "a11y";
  if (RE_DATA.test(body)) return "data";
  if (RE_LAYOUT.test(body)) return "layout";
  if (RE_COPY.test(body)) return "copy";
  if (RE_REQUEST.test(body)) return "request";
  if (body.endsWith("?") || RE_QUESTION_START.test(body)) return "question";
  if (RE_PRAISE.test(body) || PRAISE_EMOJI.test(body)) return "praise";
  return "other";
}

function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + "…" : clean;
}

/** A stable, content-light-enough "where" label per record for blind-spot grouping. */
function whereLabel(record: FeedbackRecord): string {
  const el = record.anchor?.element;
  if (el && el.tag) {
    const text = el.text ?? el.label;
    if (text && text.trim()) return `<${el.tag}> "${truncate(text, 40)}"`;
    return `<${el.tag}>`;
  }
  const heading = record.anchor?.context?.heading;
  if (heading && heading.trim()) return `heading: "${truncate(heading, 40)}"`;
  const selector = record.anchor?.selector;
  if (selector && selector.trim()) return selector;
  if (record.route && record.route.trim()) return `route: ${record.route}`;
  return "(unknown)";
}

const INTENT_ORDER: Intent[] = [
  "bug",
  "a11y",
  "data",
  "layout",
  "copy",
  "request",
  "question",
  "praise",
  "other",
];

export function retrospective(records: FeedbackRecord[]): RetroReport {
  const total = records.length;

  // ── window ────────────────────────────────────────────────────────────
  let from: string | null = null;
  let to: string | null = null;
  for (const r of records) {
    const c = r.created_at;
    if (!c) continue;
    if (from === null || c < from) from = c;
    if (to === null || c > to) to = c;
  }

  // ── outcomes ──────────────────────────────────────────────────────────
  let resolved = 0;
  let declined = 0;
  let open = 0;

  // ── per-intent tallies ────────────────────────────────────────────────
  const intentCounts = new Map<
    Intent,
    { count: number; resolved: number; declined: number; open: number }
  >();

  // ── versions ──────────────────────────────────────────────────────────
  const versionCounts = new Map<string, number>();

  // ── blind spots ───────────────────────────────────────────────────────
  const spots = new Map<
    string,
    { count: number; intents: Set<Intent>; examples: string[] }
  >();

  for (const r of records) {
    const outcome = outcomeOf(r);
    if (outcome === "resolved") resolved++;
    else if (outcome === "declined") declined++;
    else open++;

    const intent = classifyIntent(r);
    let it = intentCounts.get(intent);
    if (!it) {
      it = { count: 0, resolved: 0, declined: 0, open: 0 };
      intentCounts.set(intent, it);
    }
    it.count++;
    it[outcome]++;

    const version = r.app_version && r.app_version.trim() ? r.app_version : "(unknown)";
    versionCounts.set(version, (versionCounts.get(version) ?? 0) + 1);

    const where = whereLabel(r);
    let spot = spots.get(where);
    if (!spot) {
      spot = { count: 0, intents: new Set<Intent>(), examples: [] };
      spots.set(where, spot);
    }
    spot.count++;
    spot.intents.add(intent);
    if (spot.examples.length < 2 && r.body && r.body.trim()) {
      spot.examples.push(truncate(r.body, 60));
    }
  }

  const denom = total || 1; // avoid /0; all counts are 0 when total===0 anyway

  const intents = [...intentCounts.entries()]
    .map(([intent, v]) => ({ intent, ...v }))
    .sort((a, b) => b.count - a.count || INTENT_ORDER.indexOf(a.intent) - INTENT_ORDER.indexOf(b.intent));

  const blindSpots = [...spots.entries()]
    .filter(([, v]) => v.count >= 2)
    .map(([where, v]) => ({
      where,
      count: v.count,
      intents: [...v.intents].sort(
        (a, b) => INTENT_ORDER.indexOf(a) - INTENT_ORDER.indexOf(b),
      ),
      examples: v.examples,
    }))
    .sort((a, b) => b.count - a.count || a.where.localeCompare(b.where));

  const byVersion = [...versionCounts.entries()]
    .map(([version, count]) => ({ version, count }))
    .sort((a, b) => b.count - a.count || a.version.localeCompare(b.version));

  // ── content-free aggregate ────────────────────────────────────────────
  const aggIntents: Record<string, number> = {};
  for (const { intent, count } of intents) aggIntents[intent] = count;
  const aggVersions: Record<string, number> = {};
  for (const { version, count } of byVersion) aggVersions[version] = count;

  return {
    total,
    window: { from, to },
    outcomes: {
      resolved,
      declined,
      open,
      resolveRate: total === 0 ? 0 : resolved / denom,
      declineRate: total === 0 ? 0 : declined / denom,
      openRate: total === 0 ? 0 : open / denom,
    },
    intents,
    blindSpots,
    byVersion,
    aggregate: {
      total,
      outcomes: { resolved, declined, open },
      intents: aggIntents,
      versions: aggVersions,
      blindSpotCount: blindSpots.length,
    },
  };
}

// ── formatting ─────────────────────────────────────────────────────────────

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

const INTENT_LABEL: Record<Intent, string> = {
  bug: "bug",
  copy: "copy",
  a11y: "a11y",
  layout: "layout",
  data: "data",
  request: "request",
  question: "question",
  praise: "praise",
  other: "other",
};

/**
 * Agent-readable, scannable retrospective. Frames resolved-vs-declined as the
 * reviewer↔agent (hit/miss) axis, and closes noting the aggregate is content-free.
 * `scope` (e.g. `for project "x"`) appends to the header when given.
 */
export function formatRetrospective(report: RetroReport, scope?: string): string {
  const header = `Tyrekick retrospective${scope ? ` ${scope}` : ""}`;
  const lines: string[] = [header, "=".repeat(header.length)];

  if (report.total === 0) {
    lines.push("");
    lines.push("No feedback yet — nothing to retrospect on. Ship something reviewable and come back.");
    lines.push("");
    lines.push("(The fleet-view aggregate is content-free: counts and labels only.)");
    return lines.join("\n");
  }

  const { from, to } = report.window;
  const windowStr = from && to ? (from === to ? from : `${from} → ${to}`) : "unknown window";
  lines.push(`${report.total} comment${report.total === 1 ? "" : "s"} · ${windowStr}`);
  lines.push("");

  // Hit/miss axis
  const o = report.outcomes;
  lines.push("Reviewer ↔ agent (the hit/miss axis)");
  lines.push(`  resolved (hits):   ${o.resolved} (${pct(o.resolveRate)})`);
  lines.push(`  declined (passes): ${o.declined} (${pct(o.declineRate)})`);
  lines.push(`  open (outstanding): ${o.open} (${pct(o.openRate)})`);
  lines.push("");

  // Intents
  lines.push("What reviewers keep flagging (by intent)");
  for (const it of report.intents) {
    lines.push(
      `  ${INTENT_LABEL[it.intent].padEnd(9)} ${it.count}  ` +
        `(resolved ${it.resolved} · declined ${it.declined} · open ${it.open})`,
    );
  }
  lines.push("");

  // Blind spots
  lines.push("Recurring blind spots (same spot flagged 2+ times)");
  if (report.blindSpots.length === 0) {
    lines.push("  none — no single spot was flagged more than once.");
  } else {
    for (const b of report.blindSpots) {
      lines.push(`  ${b.where} — ${b.count}× [${b.intents.join(", ")}]`);
      for (const ex of b.examples) lines.push(`      · "${ex}"`);
    }
  }
  lines.push("");

  // Versions
  lines.push("Volume by version (regression watch)");
  for (const v of report.byVersion) {
    lines.push(`  ${v.version}: ${v.count}`);
  }
  lines.push("");

  lines.push(
    "(Fleet-view aggregate is content-free: counts + intent/version labels only — " +
      "no comment bodies, no reviewer names ever leave.)",
  );

  return lines.join("\n");
}
