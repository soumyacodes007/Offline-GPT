import { decideAccess, loadAccessPolicyRules, resolveMemberAccessContext } from "@offlinegpt-ee/den-db"
import { and, eq, inArray, isNull, or } from "@offlinegpt-ee/den-db/drizzle"
import { LlmProviderAccessTable, LlmProviderTable, MemberTable, TeamMemberTable } from "@offlinegpt-ee/den-db/schema"
import { db } from "../../db.js"

type MemberId = NonNullable<typeof LlmProviderAccessTable.$inferSelect.orgMembershipId>
type TeamId = NonNullable<typeof LlmProviderAccessTable.$inferSelect.teamId>

/**
 * The provider access entries that let this member use a provider: their own
 * grants plus access policy rules of kind `llm_provider`. A deny removes a
 * granted provider; an allow adds one (as an entry for the member, `id: null`)
 * and restricts the provider to the rule's principals.
 */
export async function listAccessibleLlmProviderAccess(input: {
  organizationId: typeof LlmProviderTable.$inferSelect.organizationId
  currentMemberId: MemberId
  teamIds: TeamId[]
}) {
  const granted = await listGrantedLlmProviderAccess(input)
  const rules = await loadAccessPolicyRules(db, { organizationId: input.organizationId, resourceKinds: ["llm_provider"] })
  if (rules.length === 0) return granted
  const context = await resolveMemberAccessContext(db, input.currentMemberId)
  if (!context) return []
  const grantedIds = new Set(granted.map((entry) => entry.llmProviderId))
  const providers = await db.select({ id: LlmProviderTable.id }).from(LlmProviderTable).where(eq(LlmProviderTable.organizationId, input.organizationId))
  const decision = (llmProviderId: string, isGranted: boolean) => decideAccess({
    rules,
    principals: context.principals,
    resourceKind: "llm_provider",
    resourceId: llmProviderId,
    baseline: isGranted ? "granted" : "closed",
  })
  const kept = granted.filter((entry) => decision(entry.llmProviderId, true).allowed)
  const added = providers
    .filter((provider) => !grantedIds.has(provider.id) && decision(provider.id, false).allowed)
    .map((provider) => ({ id: null, llmProviderId: provider.id, orgMembershipId: input.currentMemberId, teamId: null, createdAt: null }))
  return [...kept, ...added]
}

function listGrantedLlmProviderAccess(input: {
  organizationId: typeof LlmProviderTable.$inferSelect.organizationId
  currentMemberId: MemberId
  teamIds: TeamId[]
}) {
  return db
    .select({
      id: LlmProviderAccessTable.id,
      llmProviderId: LlmProviderAccessTable.llmProviderId,
      orgMembershipId: LlmProviderAccessTable.orgMembershipId,
      teamId: LlmProviderAccessTable.teamId,
      createdAt: LlmProviderAccessTable.createdAt,
    })
    .from(LlmProviderAccessTable)
    .innerJoin(LlmProviderTable, eq(LlmProviderAccessTable.llmProviderId, LlmProviderTable.id))
    .where(and(
      eq(LlmProviderTable.organizationId, input.organizationId),
      or(
        eq(LlmProviderAccessTable.orgMembershipId, input.currentMemberId),
        ...(input.teamIds.length > 0 ? [inArray(LlmProviderAccessTable.teamId, input.teamIds)] : []),
        and(
          isNull(LlmProviderAccessTable.orgMembershipId),
          isNull(LlmProviderAccessTable.teamId),
        ),
      ),
    ))
}

export async function listGrantedLlmProviderMemberIds(input: {
  organizationId: typeof LlmProviderTable.$inferSelect.organizationId
  llmProviderId: typeof LlmProviderTable.$inferSelect.id
}) {
  const rows = await db
    .selectDistinct({ id: MemberTable.id })
    .from(MemberTable)
    .leftJoin(TeamMemberTable, eq(TeamMemberTable.orgMembershipId, MemberTable.id))
    .innerJoin(LlmProviderAccessTable, or(
      eq(LlmProviderAccessTable.orgMembershipId, MemberTable.id),
      eq(LlmProviderAccessTable.teamId, TeamMemberTable.teamId),
      and(
        isNull(LlmProviderAccessTable.orgMembershipId),
        isNull(LlmProviderAccessTable.teamId),
      ),
    ))
    .where(and(
      eq(MemberTable.organizationId, input.organizationId),
      isNull(MemberTable.removedAt),
      eq(LlmProviderAccessTable.llmProviderId, input.llmProviderId),
    ))

  return rows.map((row) => row.id)
}
