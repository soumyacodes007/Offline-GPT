import { sideChatSystemContext } from "../chat/workbench-store";
import type { OfflineGptServerClient } from "../../../../app/lib/offlinegpt-server";
import { readOfflineGptEnvPendingChanges } from "../../../../app/lib/offlinegpt-env-runtime";
import { readOfflineGptRuntimeFacts, renderOfflineGptRuntimeContext } from "./runtime-context";

const DEFAULT_CACHE_KEY = "__offlinegpt_env_default__";
const MAX_CONTEXT_CACHE_ENTRIES = 100;

const envSystemContextCache = new Map<string, string | undefined>();

export function clearOfflineGptEnvSystemContextCache(): void {
  envSystemContextCache.clear();
}

function normalizeEnvKeys(keys: string[]): string[] {
  return Array.from(
    new Set(
      keys.flatMap((key) => {
        const trimmed = key.trim();
        return /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) ? [trimmed] : [];
      }),
    ),
  ).sort((a, b) => a.localeCompare(b));
}

export async function buildOfflineGptEnvSystemContext(
  client: OfflineGptServerClient | null,
  options: {
    cacheKey?: string;
    runtimeKey?: string | null;
    readPendingChanges?: () => boolean;
  } = {},
): Promise<string | undefined> {
  if (!client) return undefined;
  const readPendingChanges = options.readPendingChanges ??
    (() => readOfflineGptEnvPendingChanges(options.runtimeKey));
  if (readPendingChanges()) return undefined;

  const cacheKey = `${client.baseUrl}:${options.cacheKey ?? DEFAULT_CACHE_KEY}`;
  if (envSystemContextCache.has(cacheKey)) {
    return envSystemContextCache.get(cacheKey);
  }

  try {
    const response = await client.listUserEnvKeys();
    const keys = normalizeEnvKeys(response.keys ?? []);
    if (keys.length === 0) {
      rememberEnvSystemContext(cacheKey, undefined);
      return undefined;
    }

    const keyList = keys.map((key) => `- ${key}`).join("\n");

    const context = [
      "OfflineGPT environment variables configured:",
      keyList,
      "Only names are shown; values are secret. Use these names when relevant.",
    ].join("\n");
    rememberEnvSystemContext(cacheKey, context);
    return context;
  } catch {
    return undefined;
  }
}

function rememberEnvSystemContext(cacheKey: string, context: string | undefined): void {
  if (envSystemContextCache.size >= MAX_CONTEXT_CACHE_ENTRIES && !envSystemContextCache.has(cacheKey)) {
    const firstKey = envSystemContextCache.keys().next().value;
    if (firstKey) envSystemContextCache.delete(firstKey);
  }
  envSystemContextCache.set(cacheKey, context);
}

/**
 * The per-message `system` context every send carries: the user's time zone,
 * local date, and locale (computed fresh each send so a long-lived session
 * crosses midnight correctly), followed by the cached environment-key names
 * when the workspace has any.
 */
export async function buildOfflineGptSessionSystemContext(
  client: OfflineGptServerClient | null,
  options: {
    workspaceId?: string;
    cacheKey?: string;
    runtimeKey?: string | null;
    readPendingChanges?: () => boolean;
  } = {},
): Promise<string> {
  const envContext = await buildOfflineGptEnvSystemContext(client, options);
  const runtimeContext = renderOfflineGptRuntimeContext(readOfflineGptRuntimeFacts());
  const sideChatContext = options.workspaceId && options.cacheKey
    ? sideChatSystemContext(options.workspaceId, options.cacheKey) : undefined;
  return [runtimeContext, envContext, sideChatContext].filter(Boolean).join("\n\n");
}
