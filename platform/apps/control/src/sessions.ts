import { and, eq, gt, isNull } from "drizzle-orm";
import { inferenceKeys, members, sessions } from "@offlinegpt-platform/db";
import { randomToken, sha256 } from "./crypto";
import type { Deps } from "./deps";

export type Member = typeof members.$inferSelect;

export async function createSession(deps: Deps, memberId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(deps.now().getTime() + deps.config.sessionMs);
  await deps.db.insert(sessions).values({ tokenHash: sha256(token), memberId, createdAt: deps.now(), expiresAt });
  return { token, expiresAt };
}

/** The active member behind a token, or null. Inactive members and expired sessions never resolve. */
export async function resolveSession(deps: Deps, token: string): Promise<Member | null> {
  const [row] = await deps.db
    .select({ member: members })
    .from(sessions)
    .innerJoin(members, eq(members.id, sessions.memberId))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, deps.now()), eq(members.active, true)))
    .limit(1);
  return row?.member ?? null;
}

/** The active member behind an unrevoked inference key, or null. */
export async function resolveInferenceKey(deps: Deps, key: string): Promise<Member | null> {
  const [row] = await deps.db
    .select({ member: members })
    .from(inferenceKeys)
    .innerJoin(members, eq(members.id, inferenceKeys.memberId))
    .where(and(eq(inferenceKeys.keyHash, sha256(key)), isNull(inferenceKeys.revokedAt), eq(members.active, true)))
    .limit(1);
  return row?.member ?? null;
}

export async function endSession(deps: Deps, token: string): Promise<void> {
  await deps.db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
}

export async function endMemberSessions(deps: Deps, memberId: string): Promise<void> {
  await deps.db.delete(sessions).where(eq(sessions.memberId, memberId));
}
