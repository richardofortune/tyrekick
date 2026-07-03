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
  resolveFeedbackTool,
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
      "CSS selector, app_version). Filter by status, route, or an ISO `since` timestamp.",
    inputSchema: {
      status: z
        .enum(["open", "resolved"])
        .optional()
        .describe("Only return feedback with this status"),
      route: z.string().optional().describe("Only return feedback left on this route"),
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
    inputSchema: {},
  },
  async () => feedbackStatsTool(client),
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
