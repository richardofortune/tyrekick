#!/usr/bin/env node
/**
 * Tyrekick MCP server (stdio).
 *
 * Translates MCP tool calls into the Tyrekick worker's REST management
 * surface (see CONTRACT.md, "MCP loop" addendum). Config via env:
 *   TYREKICK_URL   — worker base URL
 *   TYREKICK_TOKEN — bearer token (wrangler secret put TYREKICK_TOKEN)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { validateEnv } from "./env.js";
import { TyrekickClient } from "./client.js";
import {
  feedbackStatsTool,
  getFeedbackTool,
  listFeedbackTool,
  triageFeedbackTool,
  resolveFeedbackTool,
  retrospectiveTool,
} from "./tools.js";

// Validate env BEFORE connecting — fail fast with a clear message.
const envResult = validateEnv(process.env);
if (!envResult.ok) {
  console.error(envResult.error);
  process.exit(1);
}

const env = envResult.env;
const client = new TyrekickClient({ baseUrl: env.url, token: env.token });

const server = new McpServer({
  name: "tyrekick",
  version: "0.1.0",
});

server.registerTool(
  "list_feedback",
  {
    title: "List feedback",
    description:
      "List reviewer feedback collected by the Tyrekick worker, newest first. " +
      "Each item is summarised (id, created_at, status, route, body, reviewer, " +
      "CSS selector, app_version). Filter by status, route, project, or an ISO `since` timestamp.",
    inputSchema: {
      status: z
        .enum(["open", "approved", "declined", "resolved"])
        .optional()
        .describe("Only return feedback with this status (open = untriaged)"),
      route: z.string().optional().describe("Only return feedback left on this route"),
      project: z
        .string()
        .optional()
        .describe("Only return feedback for this project_name (one worker can serve many projects)"),
      since: z
        .string()
        .optional()
        .describe("Only return feedback created at/after this ISO-8601 timestamp"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max items to return (worker default 50, max 200)"),
    },
  },
  async (args) => listFeedbackTool(client, args),
);

server.registerTool(
  "get_feedback",
  {
    title: "Get feedback",
    description:
      "Fetch the full feedback record by id, including the anchor " +
      "(x/y percentages, CSS selector, viewport) and reviewer environment.",
    inputSchema: {
      id: z.string().describe("Feedback record id"),
    },
  },
  async (args) => getFeedbackTool(client, args),
);

server.registerTool(
  "triage_feedback",
  {
    title: "Triage feedback",
    description:
      "Move an open feedback item through triage: approve it (cleared for an " +
      "agent to action) or decline it (won't fix, with a reason). In shared-review " +
      "mode — feedback from reviewers other than the project owner — agents must " +
      "only action items with status approved.",
    inputSchema: {
      id: z.string().describe("Feedback record id"),
      status: z.enum(["approved", "declined"]).describe("Triage decision"),
      note: z.string().optional().describe("Why (recommended for declined)"),
    },
  },
  async (args) => triageFeedbackTool(client, args),
);

server.registerTool(
  "resolve_feedback",
  {
    title: "Resolve feedback",
    description:
      "Mark a feedback item as resolved (optionally with a note describing the fix).",
    inputSchema: {
      id: z.string().describe("Feedback record id"),
      note: z.string().optional().describe("Optional resolution note"),
    },
  },
  async (args) => resolveFeedbackTool(client, args),
);

server.registerTool(
  "feedback_stats",
  {
    title: "Feedback stats",
    description:
      "Aggregate counts of feedback by status, route, and app_version " +
      "(computed from the most recent 200 items).",
    inputSchema: {
      project: z
        .string()
        .optional()
        .describe("Scope the stats to one project_name"),
    },
  },
  async (args) => feedbackStatsTool(client, args),
);

server.registerTool(
  "retrospective",
  {
    title: "Retrospective",
    description:
      "The AI feedback loop: analyse your own feedback history for patterns — what " +
      "reviewers keep flagging (intent buckets), what you did about it (resolved vs " +
      "declined vs open — the hit/miss axis), recurring blind spots, and regressions " +
      "by app_version. Computed locally over your own worker; no feedback content leaves. " +
      "Use it to see where your AI-built prototype keeps missing and improve how you brief your agent.",
    inputSchema: {
      project: z.string().optional().describe("Scope the retrospective to one project_name"),
      since: z.string().optional().describe("Only include feedback created at/after this ISO-8601 timestamp"),
      limit: z.number().int().min(1).max(200).optional().describe("Max items to analyse (default 200)"),
    },
  },
  async (args) => retrospectiveTool(client, args),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`tyrekick-mcp: connected (worker: ${env.url})`);
}

main().catch((err) => {
  console.error("tyrekick-mcp: fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
