import { KIND_BASELINES, loadRules } from "@offlinegpt-platform/access";
import { decideMany, type Subject } from "@offlinegpt-platform/policy";
import type { Deps } from "../deps";

/** Which of these plugins the subject may use. */
export async function allowedPlugins(deps: Deps, subject: Subject, slugs: Array<string | null>): Promise<Set<string>> {
  const ids = [...new Set(slugs.filter((slug): slug is string => slug !== null))];
  if (!ids.length) return new Set();
  const decisions = decideMany({ subject, kind: "plugin", ids, rules: await loadRules(deps.db, "plugin"), baseline: KIND_BASELINES.plugin, now: deps.now() });
  return new Set(ids.filter((id) => decisions.get(id)?.allowed));
}
