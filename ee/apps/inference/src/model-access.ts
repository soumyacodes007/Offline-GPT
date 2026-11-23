import {
  decideAccess,
  loadAccessPolicyRules,
  recordAccessDenied,
  resolveMemberAccessContext,
  type AccessDecision,
} from "@offlinegpt-ee/den-db"
import { db } from "./db.js"

export type ModelAccess = {
  decide(alias: string): AccessDecision
  recordDenied(alias: string, decision: Extract<AccessDecision, { allowed: false }>): Promise<void>
}

/**
 * The calling member's model access, from Den access policy rules of kind
 * "model". Models are open to the whole org until a rule restricts or denies
 * them. Returns null for a member who has left the org.
 */
export async function memberModelAccess(input: { orgMembershipId: string }): Promise<ModelAccess | null> {
  const context = await resolveMemberAccessContext(db, input.orgMembershipId)
  if (!context) return null
  const rules = await loadAccessPolicyRules(db, { organizationId: context.organizationId, resourceKinds: ["model"] })
  return {
    decide: (alias) => decideAccess({ rules, principals: context.principals, resourceKind: "model", resourceId: alias, baseline: "open" }),
    async recordDenied(alias, decision) {
      try {
        await recordAccessDenied(db, { context, resourceKind: "model", resourceId: alias, decision, surface: "inference" })
      } catch {
        console.error("[inference] failed to record access denial")
      }
    },
  }
}
