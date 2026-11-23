import { and, desc, eq, inArray, isNull } from "@offlinegpt-ee/den-db/drizzle"
import { MemberTable, WorkerInstanceTable, WorkerTable, WorkerTokenTable } from "@offlinegpt-ee/den-db/schema"
import { db } from "../db.js"
import { appLogger } from "../observability/logger.js"
import { deprovisionWorker } from "./provisioner.js"

const logger = appLogger.child({ component: "worker_member_offboarding" })

type OrgId = typeof MemberTable.$inferSelect.organizationId
type MemberId = typeof MemberTable.$inferSelect.id

/**
 * A member who leaves the org (admin removal or SCIM deprovisioning) loses
 * their workspaces at once: every worker token is revoked and each workspace
 * is stopped. Files are kept for retention; an admin deletes them explicitly.
 */
export async function offboardMemberWorkers(input: {
  organizationId: OrgId
  memberId: MemberId
  change: "added" | "removed"
}): Promise<void> {
  if (input.change !== "removed") return
  const [member] = await db
    .select({ userId: MemberTable.userId })
    .from(MemberTable)
    .where(eq(MemberTable.id, input.memberId))
    .limit(1)
  if (!member?.userId) return

  const workers = await db
    .select({ id: WorkerTable.id, destination: WorkerTable.destination })
    .from(WorkerTable)
    .where(and(eq(WorkerTable.org_id, input.organizationId), eq(WorkerTable.created_by_user_id, member.userId)))
  if (workers.length === 0) return
  const workerIds = workers.map((worker) => worker.id)

  const now = new Date()
  await db.update(WorkerTokenTable)
    .set({ revoked_at: now })
    .where(and(inArray(WorkerTokenTable.worker_id, workerIds), isNull(WorkerTokenTable.revoked_at)))
  await db.update(WorkerTable).set({ status: "stopped", updated_at: now }).where(inArray(WorkerTable.id, workerIds))

  for (const worker of workers) {
    if (worker.destination !== "cloud") continue
    const [instance] = await db
      .select({ url: WorkerInstanceTable.url })
      .from(WorkerInstanceTable)
      .where(eq(WorkerInstanceTable.worker_id, worker.id))
      .orderBy(desc(WorkerInstanceTable.created_at))
      .limit(1)
    try {
      await deprovisionWorker({ workerId: worker.id, instanceUrl: instance?.url ?? null })
    } catch (error) {
      logger.warn("failed to stop a removed member's workspace", { worker_id: worker.id, error })
    }
  }
  logger.info("removed member's workspaces stopped", { organization_id: input.organizationId, worker_count: workers.length })
}
