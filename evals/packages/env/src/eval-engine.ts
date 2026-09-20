import { resolveEvalEngineValue } from "@offlinegpt/hosts/eval-engine";
import type { EvalEngine } from "@offlinegpt/hosts/eval-engine";

export type { EvalEngine } from "@offlinegpt/hosts/eval-engine";

export function resolveEvalEngine(env: NodeJS.ProcessEnv = process.env): EvalEngine {
  return resolveEvalEngineValue(env.OFFLINEGPT_EVAL_ENGINE);
}
