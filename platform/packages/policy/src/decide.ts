import { targetMatches, targetSpecificity } from "./target";
import type { Baseline, Decision, Principal, Resource, Rule, Subject } from "./types";

export type DecideInput = {
  subject: Subject;
  resource: Resource;
  rules: readonly Rule[];
  baseline: Baseline;
  now: Date;
};

function isActive(rule: Rule, now: Date): boolean {
  return rule.expiresAt === null || rule.expiresAt.getTime() > now.getTime();
}

function principalApplies(principal: Principal, subject: Subject): boolean {
  switch (principal.type) {
    case "member":
      return principal.memberId === subject.memberId;
    case "team":
      return subject.teamIds.has(principal.teamId);
    case "role":
      return subject.roles.has(principal.role);
    case "everyone":
      return true;
  }
}

const principalRank: Record<Principal["type"], number> = { member: 3, team: 2, role: 1, everyone: 0 };

/** Negative when `a` is the better cause to report. */
function compareCause(a: Rule, b: Rule): number {
  const bySpecificity = targetSpecificity(b.target) - targetSpecificity(a.target);
  if (bySpecificity !== 0) return bySpecificity;
  const byPrincipal = principalRank[b.principal.type] - principalRank[a.principal.type];
  if (byPrincipal !== 0) return byPrincipal;
  const aExpiry = a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bExpiry = b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (aExpiry !== bExpiry) return aExpiry < bExpiry ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function best(rules: readonly Rule[]): Rule | undefined {
  let winner: Rule | undefined;
  for (const rule of rules) if (!winner || compareCause(rule, winner) < 0) winner = rule;
  return winner;
}

/** Decide one resource for one subject. Pure: `now` is an input. See docs/platform-spec/policy.md. */
export function decide({ subject, resource, rules, baseline, now }: DecideInput): Decision {
  const relevant = rules.filter((rule) => rule.kind === resource.kind && isActive(rule, now) && targetMatches(rule.target, resource.id));
  const applying = relevant.filter((rule) => principalApplies(rule.principal, subject));

  const deny = best(applying.filter((rule) => rule.effect === "deny"));
  if (deny) return { allowed: false, cause: { type: "deny-rule", rule: deny } };

  if (relevant.some((rule) => rule.effect === "allow")) {
    const allow = best(applying.filter((rule) => rule.effect === "allow"));
    return allow ? { allowed: true, cause: { type: "allow-rule", rule: allow } } : { allowed: false, cause: { type: "restricted" } };
  }

  return { allowed: baseline === "open", cause: { type: "baseline", baseline } };
}

export type DecideManyInput = Omit<DecideInput, "resource" | "rules"> & {
  kind: string;
  ids: readonly string[];
  rules: readonly Rule[];
};

/**
 * Decide many ids of one kind for one subject. The rule set is narrowed once
 * to the kind and to active rules, so cost stays linear for list endpoints.
 */
export function decideMany({ kind, ids, rules, ...rest }: DecideManyInput): Map<string, Decision> {
  const kindRules = rules.filter((rule) => rule.kind === kind && isActive(rule, rest.now));
  const decisions = new Map<string, Decision>();
  for (const id of ids) decisions.set(id, decide({ ...rest, resource: { kind, id }, rules: kindRules }));
  return decisions;
}
