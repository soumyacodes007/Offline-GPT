import { and, count, desc, eq, gt } from "drizzle-orm";
import type { Hono } from "hono";
import { accessRequests, accessRules } from "@offlinegpt-platform/db";
import { formatTarget, parseTarget } from "@offlinegpt-platform/policy";
import { z } from "zod";
import { RESOURCE_KINDS } from "@offlinegpt-platform/access";
import { audit } from "../audit";
import { newId } from "../crypto";
import type { Deps } from "../deps";
import { access, fail, readJson, type AppEnv } from "../http";

const DAY_MS = 24 * 60 * 60 * 1000;
const PENDING_LIMIT = 20;
const PENDING_DAYS = 7;

const createSchema = z.object({
  kind: z.enum(RESOURCE_KINDS),
  target: z.string().min(1).max(512),
  purpose: z.string().trim().min(1, "Say what you need it for.").max(1000),
  durationDays: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90), z.null()]),
});
const noteSchema = z.object({ note: z.string().trim().max(1000).optional() });
const listQuery = z.object({ status: z.enum(["pending", "approved", "declined", "cancelled"]).optional(), all: z.enum(["0", "1"]).default("0") });

type RequestRow = typeof accessRequests.$inferSelect;

function view(row: RequestRow, now: Date) {
  const expired = row.status === "pending" && row.expiresAt.getTime() <= now.getTime();
  return { ...row, status: expired ? "expired" : row.status };
}

export function registerRequestRoutes(app: Hono<AppEnv>, deps: Deps) {
  app.post("/v1/requests", access(deps, "member"), async (c) => {
    const body = await readJson(c, createSchema);
    const target = parseTarget(body.target);
    if (!target.ok) fail(400, "invalid_target", target.error);
    const member = c.get("member");
    const now = deps.now();
    const live = and(eq(accessRequests.memberId, member.id), eq(accessRequests.status, "pending"), gt(accessRequests.expiresAt, now));
    const [existing] = await deps.db.select().from(accessRequests)
      .where(and(live, eq(accessRequests.kind, body.kind), eq(accessRequests.target, formatTarget(target.target)))).limit(1);
    if (existing) return c.json({ request: view(existing, now) }, 200);
    const [pending] = await deps.db.select({ value: count() }).from(accessRequests).where(live);
    if ((pending?.value ?? 0) >= PENDING_LIMIT) fail(409, "too_many_requests", `You already have ${PENDING_LIMIT} requests waiting. Cancel one or wait for a decision.`);
    const id = newId("req");
    await deps.db.insert(accessRequests).values({
      id, memberId: member.id, kind: body.kind, target: formatTarget(target.target), purpose: body.purpose,
      durationDays: body.durationDays, createdAt: now, expiresAt: new Date(now.getTime() + PENDING_DAYS * DAY_MS),
    });
    await audit(deps, member.id, "request.created", { requestId: id, kind: body.kind, target: body.target });
    const [row] = await deps.db.select().from(accessRequests).where(eq(accessRequests.id, id));
    return c.json({ request: row ? view(row, now) : null }, 201);
  });

  app.get("/v1/requests", access(deps, "member"), async (c) => {
    const query = listQuery.safeParse(c.req.query());
    if (!query.success) fail(400, "invalid_query", "Unknown status filter.");
    const member = c.get("member");
    const everyone = query.data.all === "1" && member.role !== "member";
    const filters = [
      ...(everyone ? [] : [eq(accessRequests.memberId, member.id)]),
      ...(query.data.status ? [eq(accessRequests.status, query.data.status)] : []),
    ];
    const rows = await deps.db.select().from(accessRequests).where(and(...filters)).orderBy(desc(accessRequests.createdAt)).limit(500);
    const now = deps.now();
    return c.json({ requests: rows.map((row) => view(row, now)) });
  });

  app.post("/v1/requests/:id/approve", access(deps, "admin"), async (c) => {
    const id = c.req.param("id");
    const admin = c.get("member");
    const now = deps.now();
    const result = await deps.db.transaction(async (tx) => {
      const [request] = await tx.select().from(accessRequests).where(eq(accessRequests.id, id)).limit(1);
      if (!request) return { error: "not_found" } as const;
      if (request.memberId === admin.id) return { error: "own_request" } as const;
      const ruleId = newId("rule");
      // The status guard makes approval a claim: a second approver updates zero rows.
      const claimed = await tx.update(accessRequests)
        .set({ status: "approved", decidedBy: admin.id, decidedAt: now, ruleId })
        .where(and(eq(accessRequests.id, id), eq(accessRequests.status, "pending"), gt(accessRequests.expiresAt, now)))
        .returning({ id: accessRequests.id });
      if (!claimed.length) return { error: "not_pending" } as const;
      await tx.insert(accessRules).values({
        id: ruleId, kind: request.kind, target: request.target, effect: "allow", principalType: "member", principalRef: request.memberId,
        expiresAt: request.durationDays === null ? null : new Date(now.getTime() + request.durationDays * DAY_MS),
        reason: `Approved request: "${request.purpose}"`, createdBy: admin.id, createdAt: now,
      });
      return { request, ruleId } as const;
    });
    if ("error" in result) {
      if (result.error === "not_found") fail(404, "not_found", "No request with that id.");
      if (result.error === "own_request") fail(403, "own_request", "Someone else has to decide your own request.");
      fail(409, "not_pending", "This request was already decided, cancelled or has expired.");
    }
    await audit(deps, admin.id, "request.approved", { requestId: id, ruleId: result.ruleId, memberId: result.request.memberId });
    return c.json({ approved: true, ruleId: result.ruleId });
  });

  app.post("/v1/requests/:id/decline", access(deps, "admin"), async (c) => {
    const id = c.req.param("id");
    const admin = c.get("member");
    const body = await readJson(c, noteSchema);
    const [request] = await deps.db.select().from(accessRequests).where(eq(accessRequests.id, id)).limit(1);
    if (!request) fail(404, "not_found", "No request with that id.");
    if (request.memberId === admin.id) fail(403, "own_request", "Someone else has to decide your own request.");
    const now = deps.now();
    const updated = await deps.db.update(accessRequests)
      .set({ status: "declined", decidedBy: admin.id, decidedAt: now, note: body.note ?? null })
      .where(and(eq(accessRequests.id, id), eq(accessRequests.status, "pending"), gt(accessRequests.expiresAt, now)))
      .returning({ id: accessRequests.id });
    if (!updated.length) fail(409, "not_pending", "This request was already decided, cancelled or has expired.");
    await audit(deps, admin.id, "request.declined", { requestId: id, memberId: request.memberId });
    return c.json({ declined: true });
  });

  app.post("/v1/requests/:id/cancel", access(deps, "member"), async (c) => {
    const id = c.req.param("id");
    const member = c.get("member");
    const updated = await deps.db.update(accessRequests)
      .set({ status: "cancelled", decidedAt: deps.now() })
      .where(and(eq(accessRequests.id, id), eq(accessRequests.memberId, member.id), eq(accessRequests.status, "pending")))
      .returning({ id: accessRequests.id });
    if (!updated.length) fail(404, "not_found", "No pending request of yours with that id.");
    await audit(deps, member.id, "request.cancelled", { requestId: id });
    return c.json({ cancelled: true });
  });
}
