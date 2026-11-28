import { z } from "zod";
import type { Deps } from "../deps";

/**
 * A minimal MCP client (Streamable HTTP) for calling one company tool server:
 * initialize, then one request, honouring the server's session header and
 * either a JSON or an event-stream response.
 */
const PROTOCOL_VERSION = "2025-06-18";
const TIMEOUT_MS = 30_000;
/** Marks requests the platform makes as a client, so a connection that points back at the platform can't loop. */
export const PLATFORM_HOP_HEADER = "x-offlinegpt-platform-hop";

const rpcResponse = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

export const upstreamTool = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});
export type UpstreamTool = z.infer<typeof upstreamTool>;

export type Upstream = { url: string; headers: Record<string, string> };

/** Pick the response to request `id` out of a JSON body or an event stream. */
function readResponse(text: string, contentType: string, id: number): z.infer<typeof rpcResponse> {
  const candidates = contentType.includes("text/event-stream")
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())
    : [text];
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    const parsed = rpcResponse.safeParse(value);
    if (parsed.success && parsed.data.id === id) return parsed.data;
  }
  throw new Error("The tool server sent no answer to the request.");
}

async function post(deps: Deps, upstream: Upstream, body: unknown, session: string | null): Promise<Response> {
  return deps.fetch(upstream.url, {
    method: "POST",
    headers: {
      ...upstream.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      [PLATFORM_HOP_HEADER]: "1",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Run one MCP request against a tool server and return its result. Throws with a readable reason. */
export async function callUpstream(deps: Deps, upstream: Upstream, method: string, params: unknown): Promise<unknown> {
  const init = await post(deps, upstream, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "offlinegpt-platform", version: "0.1.0" } } }, null);
  if (!init.ok) throw new Error(`The tool server refused to start a session (HTTP ${init.status}).`);
  const initReply = readResponse(await init.text(), init.headers.get("content-type") ?? "", 1);
  if (initReply.error) throw new Error(`The tool server refused to start a session: ${initReply.error.message}`);
  const session = init.headers.get("mcp-session-id");

  await post(deps, upstream, { jsonrpc: "2.0", method: "notifications/initialized" }, session);
  const response = await post(deps, upstream, { jsonrpc: "2.0", id: 2, method, params }, session);
  if (!response.ok) throw new Error(`The tool server failed (HTTP ${response.status}).`);
  const reply = readResponse(await response.text(), response.headers.get("content-type") ?? "", 2);
  if (reply.error) throw new Error(reply.error.message);
  return reply.result;
}

export async function listUpstreamTools(deps: Deps, upstream: Upstream): Promise<UpstreamTool[]> {
  const result = z.object({ tools: z.array(z.unknown()) }).parse(await callUpstream(deps, upstream, "tools/list", {}));
  return result.tools.flatMap((tool) => {
    const parsed = upstreamTool.safeParse(tool);
    return parsed.success ? [parsed.data] : [];
  });
}
