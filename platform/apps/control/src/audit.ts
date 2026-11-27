import { auditEvents } from "@offlinegpt-platform/db";
import type { Deps } from "./deps";

export type AuditActor = string;

/** Append one audit event. Every mutation calls this; nothing ever updates or deletes audit rows. */
export async function audit(deps: Deps, actor: AuditActor, action: string, details: Record<string, unknown> = {}): Promise<void> {
  await deps.db.insert(auditEvents).values({ at: deps.now(), actor, action, details });
}
