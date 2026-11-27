import type { Hono } from "hono";
import { z } from "zod";
import type { Deps } from "../deps";
import { access, type AppEnv } from "../http";
import { MAX_RESULTS } from "../knowledge/search";
import { searchAsMember } from "./knowledge";

/**
 * A minimal MCP server (Streamable HTTP, JSON responses) for workspaces. It
 * runs every tool as the member whose inference key called it.
 */
const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

const searchArgs = z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(MAX_RESULTS).optional() });
const callParams = z.object({ name: z.string(), arguments: z.unknown().optional() });
const initParams = z.object({ protocolVersion: z.string().optional() }).optional();

const TOOLS = [
  {
    name: "search_knowledge",
    title: "Search company knowledge",
    description: "Search the organization's knowledge base. Returns only sections you are allowed to read, with their document path and heading. Cite the path when you use a result.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, in plain words." },
        limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS, description: "How many sections to return (default 8)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

export function registerMcpRoutes(app: Hono<AppEnv>, deps: Deps) {
  app.get("/mcp", access(deps, "agent"), (c) => c.json({ error: "Use POST for MCP requests." }, 405));

  app.post("/mcp", access(deps, "agent"), async (c) => {
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON-RPC request." } }, 400);
    const { id, method, params } = parsed.data;
    // Notifications get no response body.
    if (id === undefined) return c.body(null, 202);
    const reply = (result: unknown) => c.json({ jsonrpc: "2.0", id, result });
    const error = (code: number, message: string) => c.json({ jsonrpc: "2.0", id, error: { code, message } });

    switch (method) {
      case "initialize": {
        const init = initParams.safeParse(params);
        return reply({
          protocolVersion: (init.success ? init.data?.protocolVersion : undefined) ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "offlinegpt-workspace", version: "0.1.0" },
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const call = callParams.safeParse(params);
        if (!call.success || call.data.name !== "search_knowledge") return error(-32602, "Unknown tool.");
        const args = searchArgs.safeParse(call.data.arguments);
        if (!args.success) return reply({ isError: true, content: [{ type: "text", text: "Pass a `query` string." }] });
        const results = await searchAsMember(deps, c.get("member"), args.data.query, args.data.limit ?? 8);
        const text = results.length
          ? results.map((hit, index) => `${index + 1}. ${hit.title} › ${hit.heading} (${hit.path})\n${hit.text}`).join("\n\n")
          : "Nothing you can read matches that search.";
        return reply({ content: [{ type: "text", text }], structuredContent: { results } });
      }
      default:
        return error(-32601, `Method not found: ${method}`);
    }
  });
}
