import { and, desc, eq, like, lt } from "drizzle-orm";
import type { Hono } from "hono";
import { auditEvents } from "@offlinegpt-platform/db";
import { z } from "zod";
import type { Deps } from "../deps";
import { access, fail, type AppEnv } from "../http";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
  actor: z.string().min(1).optional(),
  action: z.string().regex(/^[a-z_.]+$/, "Use an action or prefix like `rule.`").optional(),
});

export function registerAuditRoutes(app: Hono<AppEnv>, deps: Deps) {
  app.get("/v1/audit", access(deps, "admin"), async (c) => {
    const query = querySchema.safeParse(c.req.query());
    if (!query.success) fail(400, "invalid_query", query.error.issues[0]?.message ?? "Invalid query.");
    const { limit, before, actor, action } = query.data;
    const filters = [
      ...(before ? [lt(auditEvents.id, before)] : []),
      ...(actor ? [eq(auditEvents.actor, actor)] : []),
      ...(action ? [action.endsWith(".") ? like(auditEvents.action, `${action}%`) : eq(auditEvents.action, action)] : []),
    ];
    const rows = await deps.db.select().from(auditEvents).where(and(...filters)).orderBy(desc(auditEvents.id)).limit(limit);
    const last = rows.at(-1);
    return c.json({ events: rows, nextBefore: rows.length === limit && last ? last.id : null });
  });
}
