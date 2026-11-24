import { and, desc, eq, gt } from "@offlinegpt-ee/den-db/drizzle"
import { AccessPolicyRuleTable, AccessRequestTable } from "@offlinegpt-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@offlinegpt-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { ORGANIZATION_AUDIT_ACTIONS, recordOrganizationAuditEvent } from "../../audit-events.js"
import { db } from "../../db.js"
import { updateChangedRows } from "../../db-update-result.js"
import { jsonValidator, orgMemberRoute, paramValidator, queryValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema } from "../../openapi.js"
import { ENFORCED_ACCESS_POLICY_KINDS } from "./access-policy.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOrganizationAdminRole, ensureOrganizationSuperAdmin, idParamSchema, orgAccessFailureStatus } from "./shared.js"

/** How long a request waits for an answer before it expires, as qm's asks do. */
export const ACCESS_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_PENDING_PER_MEMBER = 20

const durationSchema = z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90), z.null()])
  .describe("Days of access; null asks for access until an admin removes it.")

const createSchema = z.object({
  resourceKind: z.enum(ENFORCED_ACCESS_POLICY_KINDS),
  resourceId: z.string().trim().min(1).max(191),
  resourceLabel: z.string().trim().min(1).max(300).optional(),
  purpose: z.string().trim().min(3).max(1000).describe("Why the member needs it; shown to the approver."),
  requestedDays: durationSchema.default(7),
}).meta({ ref: "AccessRequestCreate" })

const decideSchema = z.object({
  durationDays: durationSchema.optional().describe("Approve for a different duration than requested."),
  note: z.string().trim().min(1).max(1000).optional(),
}).meta({ ref: "AccessRequestDecision" })

const listQuerySchema = z.object({
  scope: z.enum(["mine", "all"]).default("mine"),
  status: z.enum(["pending", "approved", "declined", "cancelled", "expired"]).optional(),
})

const requestSchema = z.object({}).passthrough().meta({ ref: "AccessRequest" })
const requestParamsSchema = idParamSchema("requestId", "accessRequest")

type AccessRequestRow = typeof AccessRequestTable.$inferSelect

export function accessRequestState(row: Pick<AccessRequestRow, "status" | "expiresAt">, now = new Date()) {
  return row.status === "pending" && row.expiresAt <= now ? "expired" : row.status
}

function serialize(row: AccessRequestRow, now = new Date()) {
  return {
    id: row.id,
    requesterOrgMembershipId: row.requesterOrgMembershipId,
    resourceKind: row.resourceKind,
    resourceId: row.resourceId,
    resourceLabel: row.resourceLabel,
    purpose: row.purpose,
    requestedDays: row.requestedDays,
    status: accessRequestState(row, now),
    expiresAt: row.expiresAt.toISOString(),
    decidedByOrgMembershipId: row.decidedByOrgMembershipId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    grantedRuleId: row.grantedRuleId,
    createdAt: row.createdAt.toISOString(),
  }
}

export function registerOrgAccessRequestRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.post(
    "/v1/access-requests",
    describeRoute({
      tags: ["Access Policy"],
      summary: "Request access to a resource",
      description: "Any member can ask. A pending request for the same resource is returned instead of a duplicate. Requests expire after 7 days without an answer.",
      responses: {
        201: jsonResponse("Created request.", z.object({ request: requestSchema })),
        200: jsonResponse("Existing pending request.", z.object({ request: requestSchema })),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(createSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const input = c.req.valid("json")
      const now = new Date()
      const pending = await db.select().from(AccessRequestTable).where(and(
        eq(AccessRequestTable.organizationId, payload.organization.id),
        eq(AccessRequestTable.requesterOrgMembershipId, payload.currentMember.id),
        eq(AccessRequestTable.status, "pending"),
        gt(AccessRequestTable.expiresAt, now),
      ))
      const existing = pending.find((row) => row.resourceKind === input.resourceKind && row.resourceId === input.resourceId)
      if (existing) return c.json({ request: serialize(existing, now) }, 200)
      if (pending.length >= MAX_PENDING_PER_MEMBER) {
        return c.json({ error: "too_many_pending_requests", message: `You already have ${MAX_PENDING_PER_MEMBER} requests waiting. Cancel one or wait for an answer.` }, 400)
      }
      const row: AccessRequestRow = {
        id: createDenTypeId("accessRequest"),
        organizationId: payload.organization.id,
        requesterOrgMembershipId: payload.currentMember.id,
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
        resourceLabel: input.resourceLabel ?? null,
        purpose: input.purpose,
        requestedDays: input.requestedDays,
        status: "pending",
        expiresAt: new Date(now.getTime() + ACCESS_REQUEST_TTL_MS),
        decidedByOrgMembershipId: null,
        decidedAt: null,
        decisionNote: null,
        grantedRuleId: null,
        createdAt: now,
      }
      await db.insert(AccessRequestTable).values(row)
      await recordOrganizationAuditEvent({
        organizationId: payload.organization.id,
        actorUserId: payload.currentMember.userId,
        action: ORGANIZATION_AUDIT_ACTIONS.accessRequestCreated,
        payload: { requestId: row.id, resourceKind: row.resourceKind, resourceId: row.resourceId, requestedDays: row.requestedDays },
      })
      return c.json({ request: serialize(row, now) }, 201)
    },
  )

  app.get(
    "/v1/access-requests",
    describeRoute({
      tags: ["Access Policy"],
      summary: "List access requests",
      description: "`scope=mine` (default) lists the caller's own requests; `scope=all` lists the org's and needs an admin.",
      responses: { 200: jsonResponse("Requests.", z.object({ requests: z.array(requestSchema) })), 403: jsonResponse("Forbidden.", forbiddenSchema) },
    }),
    orgMemberRoute(),
    queryValidator(listQuerySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const { scope, status } = c.req.valid("query")
      if (scope === "all") {
        const permission = ensureOrganizationAdminRole(c, "Only admins can see everyone's access requests.")
        if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
      }
      const rows = await db.select().from(AccessRequestTable).where(and(
        eq(AccessRequestTable.organizationId, payload.organization.id),
        ...(scope === "mine" ? [eq(AccessRequestTable.requesterOrgMembershipId, payload.currentMember.id)] : []),
      )).orderBy(desc(AccessRequestTable.createdAt)).limit(500)
      const now = new Date()
      const requests = rows.map((row) => serialize(row, now)).filter((row) => !status || row.status === status)
      return c.json({ requests })
    },
  )

  app.post(
    "/v1/access-requests/:requestId/approve",
    describeRoute({
      tags: ["Access Policy"],
      summary: "Approve an access request",
      description: "Writes a member allow rule for the requested (or overridden) duration. Only owners and super-admins approve; nobody approves their own request.",
      responses: {
        200: jsonResponse("Approved.", z.object({ request: requestSchema, ruleId: z.string() })),
        403: jsonResponse("Forbidden.", forbiddenSchema),
        404: jsonResponse("Not found.", notFoundSchema),
        409: jsonResponse("Already decided or expired.", invalidRequestSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(requestParamsSchema),
    jsonValidator(decideSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const permission = ensureOrganizationSuperAdmin(c, "Only owners and super-admins can approve access requests.")
      if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
      const requestId = normalizeDenTypeId("accessRequest", c.req.valid("param").requestId)
      const input = c.req.valid("json")
      const [request] = await db.select().from(AccessRequestTable).where(and(
        eq(AccessRequestTable.id, requestId),
        eq(AccessRequestTable.organizationId, payload.organization.id),
      )).limit(1)
      if (!request) return c.json({ error: "access_request_not_found" }, 404)
      if (request.requesterOrgMembershipId === payload.currentMember.id) {
        return c.json({ error: "forbidden", message: "Ask another admin to approve your own request." }, 403)
      }
      const now = new Date()
      const days = input.durationDays === undefined ? request.requestedDays : input.durationDays
      const ruleId = createDenTypeId("accessPolicyRule")
      const claimed = await db.transaction(async (tx) => {
        // The status check in the WHERE clause is the claim: two admins clicking
        // at once cannot both write a rule.
        const result = await tx.update(AccessRequestTable).set({
          status: "approved",
          decidedByOrgMembershipId: payload.currentMember.id,
          decidedAt: now,
          decisionNote: input.note ?? null,
          grantedRuleId: ruleId,
        }).where(and(eq(AccessRequestTable.id, requestId), eq(AccessRequestTable.status, "pending"), gt(AccessRequestTable.expiresAt, now)))
        if (!updateChangedRows(result)) return false
        await tx.insert(AccessPolicyRuleTable).values({
          id: ruleId,
          organizationId: payload.organization.id,
          resourceKind: request.resourceKind,
          resourceId: request.resourceId,
          principalKind: "member",
          principalId: request.requesterOrgMembershipId,
          effect: "allow",
          expiresAt: days === null ? null : new Date(now.getTime() + days * 24 * 60 * 60 * 1000),
          reason: `Approved request: "${request.purpose}" (${request.id})`.slice(0, 1000),
          createdByOrgMembershipId: payload.currentMember.id,
          createdAt: now,
          removedAt: null,
          removedByOrgMembershipId: null,
        })
        return true
      })
      if (!claimed) {
        return c.json({ error: "access_request_not_pending", message: `This request is ${accessRequestState(request, now)}.` }, 409)
      }
      await recordOrganizationAuditEvent({
        organizationId: payload.organization.id,
        actorUserId: payload.currentMember.userId,
        action: ORGANIZATION_AUDIT_ACTIONS.accessRequestApproved,
        payload: { requestId, ruleId, requesterOrgMembershipId: request.requesterOrgMembershipId, resourceKind: request.resourceKind, resourceId: request.resourceId, durationDays: days, note: input.note ?? null },
      })
      const [updated] = await db.select().from(AccessRequestTable).where(eq(AccessRequestTable.id, requestId)).limit(1)
      return c.json({ request: serialize(updated, now), ruleId })
    },
  )

  app.post(
    "/v1/access-requests/:requestId/decline",
    describeRoute({
      tags: ["Access Policy"],
      summary: "Decline an access request",
      responses: {
        200: jsonResponse("Declined.", z.object({ request: requestSchema })),
        403: jsonResponse("Forbidden.", forbiddenSchema),
        404: jsonResponse("Not found.", notFoundSchema),
        409: jsonResponse("Already decided or expired.", invalidRequestSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(requestParamsSchema),
    jsonValidator(decideSchema.pick({ note: true })),
    async (c) => {
      const payload = c.get("organizationContext")
      const permission = ensureOrganizationSuperAdmin(c, "Only owners and super-admins can decline access requests.")
      if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
      const requestId = normalizeDenTypeId("accessRequest", c.req.valid("param").requestId)
      const { note } = c.req.valid("json")
      const now = new Date()
      const result = await db.update(AccessRequestTable).set({
        status: "declined",
        decidedByOrgMembershipId: payload.currentMember.id,
        decidedAt: now,
        decisionNote: note ?? null,
      }).where(and(
        eq(AccessRequestTable.id, requestId),
        eq(AccessRequestTable.organizationId, payload.organization.id),
        eq(AccessRequestTable.status, "pending"),
      ))
      const [request] = await db.select().from(AccessRequestTable).where(and(eq(AccessRequestTable.id, requestId), eq(AccessRequestTable.organizationId, payload.organization.id))).limit(1)
      if (!request) return c.json({ error: "access_request_not_found" }, 404)
      if (!updateChangedRows(result)) return c.json({ error: "access_request_not_pending", message: `This request is ${accessRequestState(request, now)}.` }, 409)
      await recordOrganizationAuditEvent({
        organizationId: payload.organization.id,
        actorUserId: payload.currentMember.userId,
        action: ORGANIZATION_AUDIT_ACTIONS.accessRequestDeclined,
        payload: { requestId, requesterOrgMembershipId: request.requesterOrgMembershipId, resourceKind: request.resourceKind, resourceId: request.resourceId, note: note ?? null },
      })
      return c.json({ request: serialize(request, now) })
    },
  )

  app.post(
    "/v1/access-requests/:requestId/cancel",
    describeRoute({
      tags: ["Access Policy"],
      summary: "Cancel your own pending access request",
      responses: { 204: { description: "Cancelled." }, 404: jsonResponse("Not found.", notFoundSchema) },
    }),
    orgMemberRoute(),
    paramValidator(requestParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const requestId = normalizeDenTypeId("accessRequest", c.req.valid("param").requestId)
      const result = await db.update(AccessRequestTable).set({ status: "cancelled", decidedAt: new Date() }).where(and(
        eq(AccessRequestTable.id, requestId),
        eq(AccessRequestTable.organizationId, payload.organization.id),
        eq(AccessRequestTable.requesterOrgMembershipId, payload.currentMember.id),
        eq(AccessRequestTable.status, "pending"),
      ))
      if (!updateChangedRows(result)) return c.json({ error: "access_request_not_found" }, 404)
      return c.body(null, 204)
    },
  )
}
