import type { Hono } from "hono";
import { z } from "zod";
import type { Deps } from "../deps";
import { audit } from "../audit";
import { callUpstream } from "../connections/client";
import { access, type AppEnv } from "../http";
import { MAX_RESULTS } from "../knowledge/search";
import { searchAsMember } from "./knowledge";
import { connectionsFor, connectionTools, TOOL_SEPARATOR } from "./connections";
import { skillFor, skillsFor } from "./library";

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
const useSkillArgs = z.object({ slug: z.string().min(1).max(64) });
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
  {
    name: "list_skills",
    title: "List company skills",
    description: "List the company's published skills you may use: reusable instructions for common tasks. Call use_skill to read one.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "use_skill",
    title: "Use a company skill",
    description: "Read a company skill's instructions by its short name, then follow them.",
    inputSchema: { type: "object", properties: { slug: { type: "string", description: "The skill's short name from list_skills." } }, required: ["slug"], additionalProperties: false },
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
        return reply({ tools: [...TOOLS, ...(await connectionTools(deps, await connectionsFor(deps, c.get("member"))))] });
      case "tools/call": {
        const call = callParams.safeParse(params);
        if (!call.success) return error(-32602, "Unknown tool.");
        const separator = call.data.name.indexOf(TOOL_SEPARATOR);
        if (separator > 0) {
          const slug = call.data.name.slice(0, separator);
          const tool = call.data.name.slice(separator + TOOL_SEPARATOR.length);
          const member = c.get("member");
          const connection = (await connectionsFor(deps, member)).find((candidate) => candidate.slug === slug);
          if (!connection) return reply({ isError: true, content: [{ type: "text", text: `The connection "${slug}" doesn't exist or isn't available to you.` }] });
          await audit(deps, member.id, "connection.tool_called", { slug, tool });
          try {
            return reply(await callUpstream(deps, connection.upstream, "tools/call", { name: tool, arguments: call.data.arguments ?? {} }));
          } catch (failure) {
            const reason = failure instanceof Error ? failure.message : String(failure);
            return reply({ isError: true, content: [{ type: "text", text: `${connection.title} couldn't run ${tool}: ${reason}` }] });
          }
        }
        if (call.data.name === "list_skills") {
          const skills = await skillsFor(deps, c.get("member"));
          const text = skills.length ? skills.map((skill) => `- ${skill.slug}: ${skill.title} — ${skill.description}`).join("\n") : "No company skills are available to you.";
          return reply({ content: [{ type: "text", text }], structuredContent: { skills } });
        }
        if (call.data.name === "use_skill") {
          const args = useSkillArgs.safeParse(call.data.arguments);
          if (!args.success) return reply({ isError: true, content: [{ type: "text", text: "Pass a `slug` from list_skills." }] });
          const skill = await skillFor(deps, c.get("member"), args.data.slug);
          if (!skill) return reply({ isError: true, content: [{ type: "text", text: "That skill doesn't exist or isn't available to you. Ask for access on your workspace's \"My access\" page." }] });
          return reply({ content: [{ type: "text", text: `# ${skill.title}\n\n${skill.instructions}` }] });
        }
        if (call.data.name !== "search_knowledge") return error(-32602, "Unknown tool.");
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
