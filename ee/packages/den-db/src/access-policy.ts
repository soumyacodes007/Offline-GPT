import { and, eq, inArray, isNull } from "drizzle-orm"
import type { createDenDb } from "./client"
import {
  AccessPolicyRuleTable,
  type accessPolicyPrincipalKindValues,
  type accessPolicyResourceKindValues,
} from "./schema/access-policy"
import { MemberTable } from "./schema/org"
import { AuditEventTable } from "./schema/workers"
import { createDenTypeId, normalizeDenTypeId } from "@offlinegpt-ee/utils/typeid"
import { TeamMemberTable } from "./schema/teams"

type DenDb = ReturnType<typeof createDenDb>["db"]

export type AccessPolicyResourceKind = (typeof accessPolicyResourceKindValues)[number]
export type AccessPolicyPrincipalKind = (typeof accessPolicyPrincipalKindValues)[number]

export type AccessPrincipal = { kind: AccessPolicyPrincipalKind; id: string }

export type AccessPolicyRule = {
  id: string
  resourceKind: AccessPolicyResourceKind
  resourceId: string
  principalKind: AccessPolicyPrincipalKind
  principalId: string
  effect: "allow" | "deny"
  expiresAt: Date | null
  removedAt: Date | null
}

export type AccessDecision =
  | { allowed: true; via: "policy"; ruleId: string }
  | { allowed: true; via: "grant" | "open" }
  | { allowed: false; via: "policy"; ruleId: string }
  | { allowed: false; via: "restricted" | "default" }

/**
 * What the resource's own model says before any policy rule:
 * - "granted": the resource's grant table already gives this caller access;
 * - "open": everyone in the org may use it unless a rule restricts it (models);
 * - "closed": nobody has access unless a rule allows it.
 */
export type AccessBaseline = "granted" | "open" | "closed"

export const ALL_RESOURCES = "*"

function principalKey(principal: AccessPrincipal) {
  return `${principal.kind}:${principal.id}`
}

function ruleIsActive(rule: AccessPolicyRule, now: Date) {
  return rule.removedAt === null && (rule.expiresAt === null || rule.expiresAt > now)
}

/**
 * Decide one access request the way qm decides grants:
 * 1. an explicit deny on any of the caller's principals wins;
 * 2. an allow on any of the caller's principals grants access;
 * 3. a resource that has allow rules is restricted to them (an explicit grant
 *    in the resource's own table still counts), as a shared qm resource is
 *    visible only to its grantees;
 * 4. otherwise the baseline applies.
 * `rules` are all of the org's rules for the kind; principals filter them here.
 */
export function decideAccess(input: {
  rules: readonly AccessPolicyRule[]
  principals: readonly AccessPrincipal[]
  resourceKind: AccessPolicyResourceKind
  resourceId: string
  baseline: AccessBaseline
  now?: Date
}): AccessDecision {
  const now = input.now ?? new Date()
  const principals = new Set(input.principals.map(principalKey))
  let allowRuleId: string | null = null
  let restricted = false
  for (const rule of input.rules) {
    if (!ruleIsActive(rule, now)) continue
    if (rule.resourceKind !== input.resourceKind) continue
    if (rule.resourceId !== input.resourceId && rule.resourceId !== ALL_RESOURCES) continue
    if (rule.effect === "allow") restricted = true
    if (!principals.has(`${rule.principalKind}:${rule.principalId}`)) continue
    if (rule.effect === "deny") return { allowed: false, via: "policy", ruleId: rule.id }
    allowRuleId ??= rule.id
  }
  if (allowRuleId) return { allowed: true, via: "policy", ruleId: allowRuleId }
  if (input.baseline === "granted") return { allowed: true, via: "grant" }
  if (restricted) return { allowed: false, via: "restricted" }
  return input.baseline === "open" ? { allowed: true, via: "open" } : { allowed: false, via: "default" }
}

export type MemberAccessContext = {
  memberId: string
  organizationId: string
  userId: string | null
  principals: AccessPrincipal[]
}

/** Every principal a member acts as: themselves, their teams, their Den role, and the org. */
export async function resolveMemberAccessContext(db: DenDb, memberId: string): Promise<MemberAccessContext | null> {
  const [member] = await db
    .select({ id: MemberTable.id, organizationId: MemberTable.organizationId, userId: MemberTable.userId, role: MemberTable.role })
    .from(MemberTable)
    .where(and(eq(MemberTable.id, memberId as typeof MemberTable.$inferSelect.id), isNull(MemberTable.removedAt)))
    .limit(1)
  // A removed member has no principals at all, so every check fails closed.
  if (!member) return null
  const teams = await db
    .select({ teamId: TeamMemberTable.teamId })
    .from(TeamMemberTable)
    .where(eq(TeamMemberTable.orgMembershipId, member.id))
  return {
    memberId: member.id,
    organizationId: member.organizationId,
    userId: member.userId,
    principals: [
      { kind: "member", id: member.id },
      ...teams.map((team) => ({ kind: "team" as const, id: team.teamId })),
      // A member row can hold several comma-separated better-auth roles.
      ...member.role.split(",").map((role) => role.trim()).filter(Boolean).map((role) => ({ kind: "role" as const, id: role })),
      { kind: "org", id: member.organizationId },
    ],
  }
}

export const ACCESS_DENIED_AUDIT_ACTION = "access_policy.denied"

/** Record a policy denial in the org audit log (members without a user row are logged only by the caller). */
export async function recordAccessDenied(db: DenDb, input: {
  context: MemberAccessContext
  resourceKind: AccessPolicyResourceKind
  resourceId: string
  decision: Extract<AccessDecision, { allowed: false }>
  surface: string
}): Promise<void> {
  if (!input.context.userId) return
  await db.insert(AuditEventTable).values({
    id: createDenTypeId("auditEvent"),
    org_id: normalizeDenTypeId("org", input.context.organizationId),
    worker_id: null,
    actor_user_id: input.context.userId as typeof AuditEventTable.$inferInsert.actor_user_id,
    action: ACCESS_DENIED_AUDIT_ACTION,
    payload: {
      memberId: input.context.memberId,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      via: input.decision.via,
      ruleId: "ruleId" in input.decision ? input.decision.ruleId : null,
      surface: input.surface,
    },
  })
}

/** Live (not removed) rules of some kinds for an org. Expiry is checked per decision. */
export async function loadAccessPolicyRules(db: DenDb, input: {
  organizationId: string
  resourceKinds: readonly AccessPolicyResourceKind[]
}): Promise<AccessPolicyRule[]> {
  if (input.resourceKinds.length === 0) return []
  const rows = await db
    .select()
    .from(AccessPolicyRuleTable)
    .where(and(
      eq(AccessPolicyRuleTable.organizationId, input.organizationId as typeof AccessPolicyRuleTable.$inferSelect.organizationId),
      inArray(AccessPolicyRuleTable.resourceKind, [...input.resourceKinds]),
      isNull(AccessPolicyRuleTable.removedAt),
    ))
  return rows.map((row) => ({
    id: row.id,
    resourceKind: row.resourceKind,
    resourceId: row.resourceId,
    principalKind: row.principalKind,
    principalId: row.principalId,
    effect: row.effect,
    expiresAt: row.expiresAt,
    removedAt: row.removedAt,
  }))
}
