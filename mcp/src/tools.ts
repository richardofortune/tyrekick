/**
 * Tool implementations, decoupled from the MCP SDK so they are unit-testable.
 * Each returns an MCP-shaped result ({ content, isError? }) and never throws:
 * every failure — 401, non-2xx, network — becomes a tool error message.
 */

import type { FeedbackRecord, TyrekickClient, ListFeedbackParams } from "./client.js";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function err(e: unknown): ToolResult {
  const text = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text }], isError: true };
}

export function formatSummary(record: FeedbackRecord, index?: number): string {
  const prefix = index !== undefined ? `${index}. ` : "";
  const status = (record.status ?? "open").toUpperCase();
  const reviewer = record.reviewer_name ?? "Anonymous";
  const selector = record.anchor?.selector ?? "(no selector)";
  const lines = [
    `${prefix}[${record.id}] ${status} — route: ${record.route ?? "(unknown)"}`,
    `   created: ${record.created_at ?? "(unknown)"} · reviewer: ${reviewer} · app: ${
      record.app_version ?? "(unknown)"
    }`,
    `   selector: ${selector}`,
  ];

  // Schema v2 enrichment — each line only appears when the record carries the
  // field, so v1 records render exactly as before (no "undefined" noise).
  const element = record.anchor?.element;
  if (element?.tag) {
    let line = `   element: <${element.tag}>`;
    if (element.text) line += ` "${element.text}"`;
    else if (element.label) line += ` label: "${element.label}"`;
    lines.push(line);
  }
  const context = record.anchor?.context;
  const contextParts: string[] = [];
  if (context?.heading) contextParts.push(`under: "${context.heading}"`);
  if (context?.landmark) contextParts.push(`landmark: ${context.landmark}`);
  if (contextParts.length > 0) lines.push(`   ${contextParts.join(" · ")}`);
  if (Array.isArray(record.page_errors) && record.page_errors.length > 0) {
    lines.push(`   page_errors: ${record.page_errors.length}`);
  }

  lines.push(`   > ${record.body ?? ""}`);
  return lines.join("\n");
}

export async function listFeedbackTool(
  client: TyrekickClient,
  params: ListFeedbackParams = {},
): Promise<ToolResult> {
  try {
    const records = await client.listFeedback(params);
    if (records.length === 0) {
      const filters = Object.entries(params)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      return ok(`No feedback found${filters ? ` (filters: ${filters})` : ""}.`);
    }
    const header = `${records.length} feedback item(s):`;
    const body = records.map((r, i) => formatSummary(r, i + 1)).join("\n\n");
    return ok(`${header}\n\n${body}`);
  } catch (e) {
    return err(e);
  }
}

export async function getFeedbackTool(
  client: TyrekickClient,
  args: { id: string },
): Promise<ToolResult> {
  try {
    const record = await client.getFeedback(args.id);
    return ok(JSON.stringify(record, null, 2));
  } catch (e) {
    return err(e);
  }
}

export async function resolveFeedbackTool(
  client: TyrekickClient,
  args: { id: string; note?: string },
): Promise<ToolResult> {
  try {
    const record = await client.resolveFeedback(args.id, args.note);
    const lines = [
      `Resolved feedback ${record.id}.`,
      `  status: ${record.status ?? "resolved"}`,
      `  resolved_at: ${record.resolved_at ?? "(not set)"}`,
    ];
    if (record.resolution_note) lines.push(`  note: ${record.resolution_note}`);
    return ok(lines.join("\n"));
  } catch (e) {
    return err(e);
  }
}

export function aggregateStats(records: FeedbackRecord[]): {
  total: number;
  byStatus: Record<string, number>;
  byRoute: Record<string, number>;
  byAppVersion: Record<string, number>;
} {
  const byStatus: Record<string, number> = {};
  const byRoute: Record<string, number> = {};
  const byAppVersion: Record<string, number> = {};
  for (const r of records) {
    const status = r.status ?? "open";
    const route = r.route ?? "(unknown)";
    const version = r.app_version ?? "(unknown)";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    byRoute[route] = (byRoute[route] ?? 0) + 1;
    byAppVersion[version] = (byAppVersion[version] ?? 0) + 1;
  }
  return { total: records.length, byStatus, byRoute, byAppVersion };
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "  (none)";
  return entries.map(([k, n]) => `  ${k}: ${n}`).join("\n");
}

export async function feedbackStatsTool(client: TyrekickClient): Promise<ToolResult> {
  try {
    const records = await client.listFeedback({ limit: 200 });
    const stats = aggregateStats(records);
    const text = [
      `Feedback stats (${stats.total} item(s), most recent 200 max):`,
      "",
      "By status:",
      formatCounts(stats.byStatus),
      "",
      "By route:",
      formatCounts(stats.byRoute),
      "",
      "By app_version:",
      formatCounts(stats.byAppVersion),
    ].join("\n");
    return ok(text);
  } catch (e) {
    return err(e);
  }
}
