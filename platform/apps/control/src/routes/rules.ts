import { desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { accessRules, members, teams } from "@offlinegpt-platform/db";
import { decide, decideMany, formatTarget, parseTarget, type Decision } from "@offlinegpt-platform/policy";
import { z } from "zod";
import { KIND_BASELINES, loadRules, RESOURCE_KINDS, subjectOf } from "../access";
import { audit } from "../audit";
import { newId } from "../crypto";
import type { Deps } from "../deps";
import { access, fail, readJson, type AppEnv } from "../http";

const principalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("everyone") }),
  z.object({ type: z.literal("member"), id: z.string().min(1) }),
  z.object({ type: z.literal("team"), id: z.string().min(1) }),
  z.object({ type: z.literal("role"), id: z.enum(["owner", "admin", "member"]) }),
]);

const createRuleSchema = z.object({
  kind: z.enum(RESOURCE_KINDS),
  target: z.string().min(1).max(512),
  effect: z.enum(["allow", "deny"]),
  principal: principalSchema,
  expiresAt: z.iso.datetime({ offset: true }).nullable().default(null),
  reason: z.string().trim().min(1, "Say why this rule exists.").max(1000),
});

const checkSchema = z.object({ memberId: z.string().min(1), kind: z.enum(RESOURCE_KINDS), id: z.string().min(1) });

/** The decision as the API reports it: the cause names the deciding rule by id. */
function explain(decision: Decision) {
  const { cause } = decision;
  switch (cause.type) {
    case "deny-rule":
    case "allow-rule":
      return { allowed: decision.allowed, cause: { type: cause.type, ruleId: cause.rule.id, target: formatTarget(cause.rule.target), reason: cause.rule.reason } };
    case "restricted":
      return { allowed: decision.allowed, cause: { type: cause.type } };
    case "baseline":
      return { allowed: decision.allowed, cause: { type: cause.type, baseline: cause.baseline } };
  }
}

export function registerRuleRoutes(app: Hono<AppEnv>, deps: Deps) {
  app.get("/v1/rules", access(deps, "admin"), async (c) => {
    const rows = await deps.db.select().from(accessRules).orderBy(desc(accessRules.createdAt));
    return c.json({ rules: rows });
  });

  app.post("/v1/rules", access(deps, "admin"), async (c) => {
    const body = await readJson(c, createRuleSchema);
    const target = parseTarget(body.target);
    if (!target.ok) fail(400, "invalid_target", target.error);
    const { principal } = body;
    if (principal.type === "member") {
      const [found] = await deps.db.select({ id: members.id }).from(members).where(eq(members.id, principal.id)).limit(1);
      if (!found) fail(400, "unknown_member", "That member doesn't exist.");
    }
    if (principal.type === "team") {
      const [found] = await deps.db.select({ id: teams.id }).from(teams).where(eq(teams.id, principal.id)).limit(1);
      if (!found) fail(400, "unknown_team", "That team doesn't exist.");
    }
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= deps.now().getTime()) fail(400, "expired", "The expiry must be in the future.");
    const id = newId("rule");
    const actor = c.get("member").id;
    await deps.db.insert(accessRules).values({
      id,
      kind: body.kind,
      target: formatTarget(target.target),
      effect: body.effect,
      principalType: principal.type,
      principalRef: principal.type === "everyone" ? null : principal.id,
      expiresAt,
      reason: body.reason,
      createdBy: actor,
      createdAt: deps.now(),
    });
    await audit(deps, actor, "rule.created", { ruleId: id, kind: body.kind, target: body.target, effect: body.effect, principal });
    const [row] = await deps.db.select().from(accessRules).where(eq(accessRules.id, id));
    return c.json({ rule: row }, 201);
  });

  app.delete("/v1/rules/:id", access(deps, "admin"), async (c) => {
    const id = c.req.param("id");
    const deleted = await deps.db.delete(accessRules).where(eq(accessRules.id, id)).returning({ id: accessRules.id });
    if (!deleted.length) fail(404, "not_found", "No rule with that id.");
    await audit(deps, c.get("member").id, "rule.deleted", { ruleId: id });
    return c.body(null, 204);
  });

  /** Admin "check access": would this member get this resource, and why? */
  app.post("/v1/access/check", access(deps, "admin"), async (c) => {
    const body = await readJson(c, checkSchema);
    const [member] = await deps.db.select().from(members).where(eq(members.id, body.memberId)).limit(1);
    if (!member) fail(404, "not_found", "No member with that id.");
    if (!member.active) return c.json({ allowed: false, cause: { type: "inactive-member" } });
    const decision = decide({ subject: await subjectOf(deps, member), resource: { kind: body.kind, id: body.id }, rules: await loadRules(deps, body.kind), baseline: KIND_BASELINES[body.kind], now: deps.now() });
    return c.json(explain(decision));
  });

  /** What the signed-in member may use, for a list of ids of one kind. */
  app.get("/v1/me/access", access(deps, "member"), async (c) => {
    const kind = z.enum(RESOURCE_KINDS).safeParse(c.req.query("kind"));
    if (!kind.success) fail(400, "invalid_kind", "Pass ?kind= with a known resource kind.");
    const ids = (c.req.query("ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean).slice(0, 500);
    const decisions = decideMany({ subject: await subjectOf(deps, c.get("member")), kind: kind.data, ids, rules: await loadRules(deps, kind.data), baseline: KIND_BASELINES[kind.data], now: deps.now() });
    return c.json({ kind: kind.data, decisions: Object.fromEntries([...decisions].map(([id, decision]) => [id, explain(decision)])) });
  });
}
