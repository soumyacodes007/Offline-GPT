import { eq } from "drizzle-orm";
import { accessRules, teamMembers } from "@offlinegpt-platform/db";
import { parseTarget, type Baseline, type Principal, type Rule, type Subject } from "@offlinegpt-platform/policy";
import type { Deps } from "./deps";
import type { Member } from "./sessions";

export const RESOURCE_KINDS = ["model", "capability", "skill", "plugin", "mcp-connection", "knowledge-document", "knowledge-section", "workspace-setting"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** What happens to a resource of each kind when no allow rule names it. */
export const KIND_BASELINES: Record<ResourceKind, Baseline> = {
  model: "open",
  capability: "open",
  skill: "open",
  plugin: "closed",
  "mcp-connection": "closed",
  "knowledge-document": "closed",
  "knowledge-section": "open",
  "workspace-setting": "open",
};

type RuleRow = typeof accessRules.$inferSelect;

function principalOf(row: RuleRow): Principal | null {
  switch (row.principalType) {
    case "everyone":
      return { type: "everyone" };
    case "member":
      return row.principalRef ? { type: "member", memberId: row.principalRef } : null;
    case "team":
      return row.principalRef ? { type: "team", teamId: row.principalRef } : null;
    case "role":
      return row.principalRef ? { type: "role", role: row.principalRef } : null;
  }
}

/** Convert stored rows to engine rules. Rows that no longer parse are skipped rather than failing every decision. */
export function toRule(row: RuleRow): Rule | null {
  const target = parseTarget(row.target);
  const principal = principalOf(row);
  if (!target.ok || !principal) return null;
  return { id: row.id, kind: row.kind, target: target.target, principal, effect: row.effect, expiresAt: row.expiresAt, reason: row.reason };
}

export async function loadRules(deps: Deps, kind?: string): Promise<Rule[]> {
  const rows = kind ? await deps.db.select().from(accessRules).where(eq(accessRules.kind, kind)) : await deps.db.select().from(accessRules);
  return rows.map(toRule).filter((rule): rule is Rule => rule !== null);
}

export async function subjectOf(deps: Deps, member: Member): Promise<Subject> {
  const rows = await deps.db.select({ teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.memberId, member.id));
  return { memberId: member.id, teamIds: new Set(rows.map((row) => row.teamId)), roles: new Set([member.role]) };
}
