import { asc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { KIND_BASELINES, loadRules, subjectOf } from "@offlinegpt-platform/access";
import { mcpConnections } from "@offlinegpt-platform/db";
import { decideMany } from "@offlinegpt-platform/policy";
import { z } from "zod";
import { audit } from "../audit";
import { listUpstreamTools, type Upstream, type UpstreamTool } from "../connections/client";
import { decryptSecret, encryptSecret, newId } from "../crypto";
import type { Deps } from "../deps";
import { access, fail, readJson, type AppEnv } from "../http";
import type { Member } from "../sessions";

/** Separates a connection's slug from its tool's name in the names the agent sees. */
export const TOOL_SEPARATOR = "__";

const connectionSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "Use lowercase letters, numbers and `-` for the short name (at most 32)."),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(500),
  url: z.url({ protocol: /^https?$/ }),
  header: z.object({ name: z.string().regex(/^[A-Za-z0-9-]{1,64}$/), value: z.string().min(1).max(4096) }).optional(),
});

type ConnectionRow = typeof mcpConnections.$inferSelect;
export type AllowedConnection = { slug: string; title: string; upstream: Upstream };

function upstreamOf(deps: Deps, row: ConnectionRow): Upstream {
  if (!row.headerName || !row.headerValueSealed) return { url: row.url, headers: {} };
  if (!deps.config.secretsKey) throw new Error("SECRETS_KEY is not set, so the stored credential can't be read.");
  return { url: row.url, headers: { [row.headerName]: decryptSecret(deps.config.secretsKey, row.headerValueSealed) } };
}

/** Connections this member may use, ready to call. */
export async function connectionsFor(deps: Deps, member: Member): Promise<AllowedConnection[]> {
  const rows = await deps.db.select().from(mcpConnections).orderBy(asc(mcpConnections.slug));
  if (!rows.length) return [];
  const decisions = decideMany({ subject: await subjectOf(deps.db, member), kind: "mcp-connection", ids: rows.map((row) => row.slug), rules: await loadRules(deps.db, "mcp-connection"), baseline: KIND_BASELINES["mcp-connection"], now: deps.now() });
  return rows.flatMap((row) => {
    if (!decisions.get(row.slug)?.allowed) return [];
    try {
      return [{ slug: row.slug, title: row.title, upstream: upstreamOf(deps, row) }];
    } catch {
      return [];
    }
  });
}

/** The tools of every allowed connection, renamed `<slug>__<tool>`. A failing server is skipped. */
export async function connectionTools(deps: Deps, connections: AllowedConnection[]) {
  const lists = await Promise.all(connections.map(async (connection) => {
    let tools: UpstreamTool[];
    try {
      tools = await listUpstreamTools(deps, connection.upstream);
    } catch {
      return [];
    }
    return tools.map((tool) => ({
      name: `${connection.slug}${TOOL_SEPARATOR}${tool.name}`,
      title: `${connection.title}: ${tool.name}`,
      description: `From ${connection.title}. ${tool.description ?? ""}`.trim(),
      inputSchema: tool.inputSchema ?? { type: "object" },
    }));
  }));
  return lists.flat();
}

export function registerConnectionRoutes(app: Hono<AppEnv>, deps: Deps) {
  app.post("/v1/library/connections", access(deps, "admin"), async (c) => {
    const body = await readJson(c, connectionSchema);
    if (body.header && !deps.config.secretsKey) fail(400, "secrets_key_missing", "Set SECRETS_KEY on the server before saving a connection credential.");
    const actor = c.get("member").id;
    const sealed = body.header && deps.config.secretsKey ? { headerName: body.header.name, headerValueSealed: encryptSecret(deps.config.secretsKey, body.header.value) } : {};
    const values = { title: body.title, description: body.description, url: body.url, ...sealed, createdBy: actor, updatedAt: deps.now() };
    await deps.db.insert(mcpConnections).values({ id: newId("conn"), slug: body.slug, ...values })
      .onConflictDoUpdate({ target: mcpConnections.slug, set: values });
    await audit(deps, actor, "connection.saved", { slug: body.slug, url: body.url, headerName: body.header?.name ?? null });
    return c.json({ connection: { slug: body.slug, title: body.title } }, 201);
  });

  app.get("/v1/library/connections", access(deps, "admin"), async (c) => {
    const rows = await deps.db.select().from(mcpConnections).orderBy(asc(mcpConnections.slug));
    return c.json({
      connections: rows.map((row) => ({ slug: row.slug, title: row.title, description: row.description, url: row.url, headerName: row.headerName, hasSecret: row.headerValueSealed !== null, updatedAt: row.updatedAt })),
    });
  });

  app.delete("/v1/library/connections/:slug", access(deps, "admin"), async (c) => {
    const slug = c.req.param("slug");
    const deleted = await deps.db.delete(mcpConnections).where(eq(mcpConnections.slug, slug)).returning({ slug: mcpConnections.slug });
    if (!deleted.length) fail(404, "not_found", "No connection with that name.");
    await audit(deps, c.get("member").id, "connection.deleted", { slug });
    return c.body(null, 204);
  });
}
