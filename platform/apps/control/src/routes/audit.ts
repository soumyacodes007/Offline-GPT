import { and, asc, desc, eq, gt, gte, like, lt } from "drizzle-orm";
import type { Hono } from "hono";
import { auditEvents } from "@offlinegpt-platform/db";
import { z } from "zod";
import type { Deps } from "../deps";
import { audit } from "../audit";
import { access, fail, type AppEnv } from "../http";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
  actor: z.string().min(1).optional(),
  action: z.string().regex(/^[a-z_.]+$/, "Use an action or prefix like `rule.`").optional(),
});

const exportSchema = z.object({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() });
const EXPORT_BATCH = 1000;

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

  /** The whole log (or a time window) as JSON Lines, oldest first, streamed in batches. */
  app.get("/v1/audit/export", access(deps, "admin"), async (c) => {
    const query = exportSchema.safeParse(c.req.query());
    if (!query.success) fail(400, "invalid_query", "`from` and `to` must be ISO date-times, e.g. 2026-01-01T00:00:00Z.");
    const window = [
      ...(query.data.from ? [gte(auditEvents.at, new Date(query.data.from))] : []),
      ...(query.data.to ? [lt(auditEvents.at, new Date(query.data.to))] : []),
    ];
    await audit(deps, c.get("member").id, "audit.exported", { from: query.data.from ?? null, to: query.data.to ?? null });
    const encoder = new TextEncoder();
    let after = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const rows = await deps.db.select().from(auditEvents).where(and(gt(auditEvents.id, after), ...window)).orderBy(asc(auditEvents.id)).limit(EXPORT_BATCH);
        if (rows.length) controller.enqueue(encoder.encode(rows.map((row) => `${JSON.stringify(row)}\n`).join("")));
        const last = rows.at(-1);
        if (!last || rows.length < EXPORT_BATCH) controller.close();
        else after = last.id;
      },
    });
    const stamp = deps.now().toISOString().slice(0, 10);
    return c.body(body, 200, { "content-type": "application/x-ndjson", "content-disposition": `attachment; filename="audit-${stamp}.jsonl"` });
  });
}
