import type { EngineV2Preview } from "./engine-v2-preview.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const items = (json: unknown): unknown[] => (isRecord(json) && Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : []);
const text = (value: unknown, key: string): string | undefined =>
  isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;

/**
 * Read OpenCode v2's effective config and agents in the v1 `/config` and
 * `/agent` shapes that diagnostics and effective permissions validate.
 */
export async function readV2EngineInspection(
  fetchJson: EngineV2Preview["fetchJson"],
  directory: string,
  signal?: AbortSignal,
): Promise<{ config: Record<string, unknown>; agents: unknown[] }> {
  const read = () => Promise.all([
    fetchJson("/api/config", { directory, timeoutMs: 10_000 }),
    fetchJson("/api/agent", { directory, timeoutMs: 10_000 }),
    fetchJson("/api/mcp", { directory, timeoutMs: 10_000 }),
  ]);
  signal?.throwIfAborted();
  let [configResult, agentResult, mcpResult] = await read();
  // While a location reloads, v2 briefly answers with no agents; wait for the rebuilt list.
  for (let attempt = 0; attempt < 10 && agentResult.status === 200 && items(agentResult.json).length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    signal?.throwIfAborted();
    [configResult, agentResult, mcpResult] = await read();
  }
  signal?.throwIfAborted();
  if (configResult.status !== 200 || agentResult.status !== 200) {
    throw new Error(`OpenCode v2 inspection failed (${configResult.status}/${agentResult.status})`);
  }
  // v2 returns one entry per config document, lowest precedence first.
  let defaultAgent: string | undefined;
  const plugin: string[] = [];
  const mcp: Record<string, unknown> = {};
  for (const entry of items(configResult.json)) {
    const info = isRecord(entry) ? entry.info : undefined;
    if (!isRecord(info)) continue;
    defaultAgent = text(info, "default_agent") ?? defaultAgent;
    for (const spec of Array.isArray(info.plugins) ? info.plugins : []) {
      const name = typeof spec === "string" ? spec : text(spec, "package");
      if (name) plugin.push(name);
    }
    const servers = isRecord(info.mcp) && isRecord(info.mcp.servers) ? info.mcp.servers : {};
    Object.assign(mcp, servers);
  }
  // OfflineGPT registers workspace MCPs at runtime, so they are live but absent from config documents.
  for (const server of items(mcpResult.json)) {
    const name = text(server, "name");
    if (name && !isRecord(mcp[name])) mcp[name] = { enabled: true };
  }
  const agents = items(agentResult.json).flatMap((agent) => {
    const name = text(agent, "id");
    if (!isRecord(agent) || !name) return [];
    const permissions = Array.isArray(agent.permissions) ? agent.permissions : [];
    return [{
      name,
      mode: agent.mode,
      hidden: agent.hidden === true,
      prompt: text(agent, "prompt") ?? "",
      // OpenCode 2.3 renamed the rule fields: action → permission, resource → pattern, effect → action.
      permission: permissions.flatMap((rule) => {
        const permission = text(rule, "action");
        const pattern = text(rule, "resource");
        const action = text(rule, "effect");
        return permission && pattern && action ? [{ permission, pattern, action }] : [];
      }),
    }];
  });
  return { config: { ...(defaultAgent ? { default_agent: defaultAgent } : {}), plugin, mcp }, agents };
}

type McpState = { status: "connected" } | { status: "disabled" } | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string } | { status: "failed"; error: string };

/** OpenCode v2's live MCP statuses in the v1 `/mcp` shape. */
export async function readV2McpStatus(fetchJson: EngineV2Preview["fetchJson"], directory: string): Promise<Record<string, McpState>> {
  const result = await fetchJson("/api/mcp", { directory, timeoutMs: 5_000 });
  if (result.status !== 200) throw new Error(`OpenCode v2 /api/mcp returned ${result.status}`);
  const statuses: Record<string, McpState> = {};
  for (const server of items(result.json)) {
    const name = text(server, "name");
    const status = isRecord(server) ? server.status : undefined;
    const state = text(status, "status");
    // v1 has no "pending": leave a connecting server out so callers keep waiting for it.
    if (!name || !state || state === "pending") continue;
    const error = text(status, "error") ?? "";
    statuses[name] = state === "connected" || state === "disabled" || state === "needs_auth"
      ? { status: state }
      : state === "needs_client_registration" ? { status: state, error } : { status: "failed", error };
  }
  return statuses;
}
