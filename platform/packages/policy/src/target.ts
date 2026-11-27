import type { Target } from "./types";

export type TargetParseResult = { ok: true; target: Target } | { ok: false; error: string };

/**
 * Parse a target as written by an admin: an exact id, or a prefix pattern that
 * ends in a single `*`. Validation happens here, when a rule is created, so the
 * decision itself never fails.
 */
export function parseTarget(raw: string): TargetParseResult {
  const value = raw.trim();
  if (!value) return { ok: false, error: "Target is empty." };
  const star = value.indexOf("*");
  if (star === -1) return { ok: true, target: { type: "exact", id: value } };
  if (star !== value.length - 1) return { ok: false, error: "A target may contain one `*`, and only at the end." };
  return { ok: true, target: { type: "prefix", prefix: value.slice(0, -1) } };
}

export function formatTarget(target: Target): string {
  return target.type === "exact" ? target.id : `${target.prefix}*`;
}

export function targetMatches(target: Target, id: string): boolean {
  return target.type === "exact" ? target.id === id : id.startsWith(target.prefix);
}

/** Higher is more specific: any exact id beats every pattern; longer patterns beat shorter ones. */
export function targetSpecificity(target: Target): number {
  return target.type === "exact" ? Number.MAX_SAFE_INTEGER : target.prefix.length;
}
