import { and, eq, gte, isNull, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { inferenceKeys, members, usageRecords } from "@offlinegpt-platform/db";
import { z } from "zod";
import { audit } from "../audit";
import { newId, randomToken, sha256 } from "../crypto";
import type { Deps } from "../deps";
import { access, fail, type AppEnv } from "../http";

const usageQuery = z.object({ days: z.coerce.number().int().min(1).max(366).default(7) });

export function registerInferenceRoutes(app: Hono<AppEnv>, deps: Deps) {
  /** Issue the member's inference key; any previous key stops working. */
  app.post("/v1/me/inference-key", access(deps, "member"), async (c) => {
    const member = c.get("member");
    const key = `ogk_${randomToken(32)}`;
    const prefix = key.slice(0, 10);
    const now = deps.now();
    await deps.db.transaction(async (tx) => {
      await tx.update(inferenceKeys).set({ revokedAt: now }).where(and(eq(inferenceKeys.memberId, member.id), isNull(inferenceKeys.revokedAt)));
      await tx.insert(inferenceKeys).values({ id: newId("ikey"), memberId: member.id, keyHash: sha256(key), prefix, createdAt: now });
    });
    await audit(deps, member.id, "inference_key.issued", { prefix });
    return c.json({ key, prefix }, 201);
  });

  app.get("/v1/usage", access(deps, "admin"), async (c) => {
    const query = usageQuery.safeParse(c.req.query());
    if (!query.success) fail(400, "invalid_query", "`days` must be between 1 and 366.");
    const since = new Date(deps.now().getTime() - query.data.days * 24 * 60 * 60 * 1000);
    const rows = await deps.db
      .select({
        memberId: usageRecords.memberId,
        email: members.email,
        model: usageRecords.model,
        calls: sql<number>`count(*)::int`,
        failed: sql<number>`count(*) filter (where ${usageRecords.status} = 'failed')::int`,
        promptTokens: sql<number>`coalesce(sum(${usageRecords.promptTokens}), 0)::int`,
        completionTokens: sql<number>`coalesce(sum(${usageRecords.completionTokens}), 0)::int`,
      })
      .from(usageRecords)
      .innerJoin(members, eq(members.id, usageRecords.memberId))
      .where(gte(usageRecords.at, since))
      .groupBy(usageRecords.memberId, members.email, usageRecords.model)
      .orderBy(members.email, usageRecords.model);
    return c.json({ since: since.toISOString(), usage: rows });
  });
}
