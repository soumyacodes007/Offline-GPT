import {
  ALL_RESOURCES,
  decideAccess,
  loadAccessPolicyRules,
  resolveMemberAccessContext,
} from "@offlinegpt-ee/den-db"
import { and, desc, eq, isNull } from "@offlinegpt-ee/den-db/drizzle"
import { AccessPolicyRuleTable, MemberTable, TeamTable } from "@offlinegpt-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@offlinegpt-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { ORGANIZATION_AUDIT_ACTIONS, recordOrganizationAuditEvent } from "../../audit-events.js"
import { db } from "../../db.js"
import { jsonValidator, orgRoleRoute, paramValidator, queryValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOrganizationSuperAdmin, idParamSchema, orgAccessFailureStatus } from "./shared.js"

/**
 * Resource kinds whose use is checked against access policy rules today. The
 * table accepts more kinds for future surfaces; the API refuses a rule that
 * would not be enforced, so an admin never sees a rule that does nothing.
 */
export const ENFORCED_ACCESS_POLICY_KINDS = [
  "model",
  "plugin",
  "marketplace",
  "config_object",
  "connector_instance",
  "mcp_connection",
  "llm_provider",
  "capability",
  "knowledge_document",
  "knowledge_chunk",
] as const

const ruleWriteSchema = z.object({
  resourceKind: z.enum(ENFORCED_ACCESS_POLICY_KINDS),
  resourceId: z.string().trim().min(1).max(191).describe(`A resource id, a model alias, or "${ALL_RESOURCES}" for every resource of the kind.`),
  principalKind: z.enum(["member", "team", "role", "org"]),
  principalId: z.string().trim().min(1).max(191).describe("A member id, team id, Den role name, or the organization id."),
  effect: z.enum(["allow", "deny"]),
  expiresAt: z.string().datetime({ offset: true }).optional().describe("Time-bound rule: it stops applying at this instant."),
  reason: z.string().trim().min(1).max(1000).optional(),
}).meta({ ref: "AccessPolicyRuleWrite" })

const ruleSchema = z.object({}).passthrough().meta({ ref: "AccessPolicyRule" })
const listQuerySchema = z.object({ resourceKind: z.enum(ENFORCED_ACCESS_POLICY_KINDS).optional() })
const ruleParamsSchema = idParamSchema("ruleId", "accessPolicyRule")
const checkSchema = z.object({
  memberId: z.string().trim().min(1),
  resourceKind: z.enum(ENFORCED_ACCESS_POLICY_KINDS),
  resourceId: z.string().trim().min(1).max(191),
}).meta({ ref: "AccessPolicyCheck" })

type OrganizationId = typeof AccessPolicyRuleTable.$inferSelect.organizationId

function serializeRule(row: typeof AccessPolicyRuleTable.$inferSelect, now = new Date()) {
  return {
    id: row.id,
    resourceKind: row.resourceKind,
    resourceId: row.resourceId,
    principalKind: row.principalKind,
    principalId: row.principalId,
    effect: row.effect,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    expired: row.expiresAt !== null && row.expiresAt <= now,
    reason: row.reason,
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function principalExists(organizationId: OrganizationId, kind: z.infer<typeof ruleWriteSchema>["principalKind"], id: string) {
  if (kind === "role") return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)
  if (kind === "org") return id === organizationId
  try {
    if (kind === "member") {
      const [row] = await db.select({ id: MemberTable.id }).from(MemberTable)
        .where(and(eq(MemberTable.id, normalizeDenTypeId("member", id)), eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt))).limit(1)
      return Boolean(row)
    }
    const [row] = await db.select({ id: TeamTable.id }).from(TeamTable)
      .where(and(eq(TeamTable.id, normalizeDenTypeId("team", id)), eq(TeamTable.organizationId, organizationId))).limit(1)
    return Boolean(row)
  } catch {
    return false
  }
}

export function registerOrgAccessPolicyRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/access-policy/rules",
    describeRoute({
      tags: ["Access Policy"],
      summary: "List access policy rules",
      description: "Live rules (not removed), newest first. Expired rules are listed with expired=true and no longer apply.",
      responses: { 200: jsonResponse("Rules.", z.object({ rules: z.array(ruleSchema) })), 403: jsonResponse("Forbidden.", forbiddenSchema) },
    }),
    orgRoleRoute(["admin"]),
    queryValidator(listQuerySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const { resourceKind } = c.req.valid("query")
      const rows = await db.select().from(AccessPolicyRuleTable).where(and(
        eq(AccessPolicyRuleTable.organizationId, payload.organization.id),
        isNull(AccessPolicyRuleTable.removedAt),
        ...(resourceKind ? [eq(AccessPolicyRuleTable.resourceKind, resourceKind)] : []),
      )).orderBy(desc(AccessPolicyRuleTable.createdAt))
      const now = new Date()
      return c.json({ rules: rows.map((row) => serializeRule(row, now)) })
    },
  )

  app.post(
    "/v1/access-policy/rules",
    describeRoute({
      tags: ["Access Policy"],
      summary: "Create an access policy rule",
      description: "Deny always wins. An allow rule gives its principals access and restricts the resource to them (explicit grants still count).",
      responses: {
        201: jsonResponse("Created rule.", z.object({ rule: ruleSchema })),
        400: jsonResponse("Invalid rule.", invalidRequestSchema),
        403: jsonResponse("Forbidden.", forbiddenSchema),
      },
    }),
    orgRoleRoute(["super-admin"]),
    jsonValidator(ruleWriteSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const permission = ensureOrganizationSuperAdmin(c, "Only owners and super-admins can manage access policy.")
      if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
      const input = c.req.valid("json")
      const principalId = input.principalKind === "org" && input.principalId === "*" ? payload.organization.id : input.principalId
      if (!(await principalExists(payload.organization.id, input.principalKind, principalId))) {
        return c.json({ error: "invalid_principal", message: `No ${input.principalKind} ${principalId} in this organization.` }, 400)
      }
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null
      if (expiresAt && expiresAt <= new Date()) {
        return c.json({ error: "invalid_expiry", message: "expiresAt must be in the future." }, 400)
      }
      const row = {
        id: createDenTypeId("accessPolicyRule"),
        organizationId: payload.organization.id,
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
        principalKind: input.principalKind,
        principalId,
        effect: input.effect,
        expiresAt,
        reason: input.reason ?? null,
        createdByOrgMembershipId: payload.currentMember.id,
        createdAt: new Date(),
        removedAt: null,
        removedByOrgMembershipId: null,
      }
      await db.insert(AccessPolicyRuleTable).values(row)
      await recordOrganizationAuditEvent({
        organizationId: payload.organization.id,
        actorUserId: payload.currentMember.userId,
        action: ORGANIZATION_AUDIT_ACTIONS.accessPolicyRuleCreated,
        payload: {
          ruleId: row.id,
          resourceKind: row.resourceKind,
          resourceId: row.resourceId,
          principalKind: row.principalKind,
          principalId: row.principalId,
          effect: row.effect,
          expiresAt: row.expiresAt?.toISOString() ?? null,
          reason: row.reason,
        },
      })
      return c.json({ rule: serializeRule(row) }, 201)
    },
  )

  app.delete(
    "/v1/access-policy/rules/:ruleId",
    describeRoute({
      tags: ["Access Policy"],
      summary: "Remove an access policy rule",
      responses: { 204: { description: "Removed." }, 404: jsonResponse("Not found.", notFoundSchema) },
    }),
    orgRoleRoute(["super-admin"]),
    paramValidator(ruleParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const permission = ensureOrganizationSuperAdmin(c, "Only owners and super-admins can manage access policy.")
      if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
      const ruleId = normalizeDenTypeId("accessPolicyRule", c.req.valid("param").ruleId)
      const [existing] = await db.select().from(AccessPolicyRuleTable).where(and(
        eq(AccessPolicyRuleTable.id, ruleId),
        eq(AccessPolicyRuleTable.organizationId, payload.organization.id),
        isNull(AccessPolicyRuleTable.removedAt),
      )).limit(1)
      if (!existing) return c.json({ error: "access_policy_rule_not_found" }, 404)
      await db.update(AccessPolicyRuleTable)
        .set({ removedAt: new Date(), removedByOrgMembershipId: payload.currentMember.id })
        .where(eq(AccessPolicyRuleTable.id, ruleId))
      await recordOrganizationAuditEvent({
        organizationId: payload.organization.id,
        actorUserId: payload.currentMember.userId,
        action: ORGANIZATION_AUDIT_ACTIONS.accessPolicyRuleRemoved,
        payload: { ruleId, resourceKind: existing.resourceKind, resourceId: existing.resourceId, principalKind: existing.principalKind, principalId: existing.principalId, effect: existing.effect },
      })
      return c.body(null, 204)
    },
  )

  app.post(
    "/v1/access-policy/check",
    describeRoute({
      tags: ["Access Policy"],
      summary: "Explain what access policy decides for one member and resource",
      description: "For access reviews. Models start open; other kinds are checked as if the member held no resource grant, so `restricted`/`default` means only policy rules were consulted.",
      responses: { 200: jsonResponse("Decision.", z.object({}).passthrough()), 404: jsonResponse("Member not found.", notFoundSchema) },
    }),
    orgRoleRoute(["admin"]),
    jsonValidator(checkSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const input = c.req.valid("json")
      let memberId: string
      try {
        memberId = normalizeDenTypeId("member", input.memberId)
      } catch {
        return c.json({ error: "member_not_found" }, 404)
      }
      const context = await resolveMemberAccessContext(db, memberId)
      if (!context || context.organizationId !== payload.organization.id) return c.json({ error: "member_not_found" }, 404)
      const rules = await loadAccessPolicyRules(db, { organizationId: payload.organization.id, resourceKinds: [input.resourceKind] })
      const decision = decideAccess({
        rules,
        principals: context.principals,
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
        baseline: input.resourceKind === "model" || input.resourceKind === "capability" || input.resourceKind === "knowledge_chunk" ? "open" : "closed",
      })
      return c.json({ decision, principals: context.principals })
    },
  )
}
