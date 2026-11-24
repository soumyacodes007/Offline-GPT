import { decideAccess, loadAccessPolicyRules, recordAccessDenied, resolveMemberAccessContext, type AccessDecision, type MemberAccessContext } from "@offlinegpt-ee/den-db"
import type { DenTypeId } from "@offlinegpt-ee/utils/typeid"
import { db } from "../db.js"
import type { McpMemberIdentity } from "./external-capabilities.js"

/**
 * Access policy rules of kind `capability` apply on top of every capability
 * source's own grants: a deny hides a capability from search and refuses it on
 * execute; allow rules restrict it to their principals. Rule resource ids are
 * capability names, or a prefix ending in `*` such as `mcp:<connectionId>:*`.
 */
export type CapabilityPolicy = {
  decide: (name: string) => AccessDecision
  context: MemberAccessContext
}

export async function loadCapabilityPolicy(input: {
  organizationId: DenTypeId<"organization">
  member: McpMemberIdentity | null
}): Promise<CapabilityPolicy | null> {
  if (!input.member) return null
  const rules = await loadAccessPolicyRules(db, { organizationId: input.organizationId, resourceKinds: ["capability"] })
  if (rules.length === 0) return null
  const context = await resolveMemberAccessContext(db, input.member.orgMembershipId)
  if (!context) return { context: { memberId: input.member.orgMembershipId, organizationId: input.organizationId, userId: null, principals: [] }, decide: () => ({ allowed: false, via: "default" }) }
  return {
    context,
    decide: (name) => decideAccess({ rules, principals: context.principals, resourceKind: "capability", resourceId: name, baseline: "open" }),
  }
}

export async function recordCapabilityDenied(policy: CapabilityPolicy, name: string, decision: Extract<AccessDecision, { allowed: false }>) {
  await recordAccessDenied(db, { context: policy.context, resourceKind: "capability", resourceId: name, decision, surface: "mcp_execute_capability" })
}
