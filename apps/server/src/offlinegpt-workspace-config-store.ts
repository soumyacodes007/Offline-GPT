import type { ServerConfig } from "./types.js";
import { createWorkspaceKvStore, isRecord } from "./workspace-kv-store.js";

function normalizeOfflineGptWorkspaceConfig(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function parseOfflineGptWorkspaceConfig(configJson: string): Record<string, unknown> {
  try {
    return normalizeOfflineGptWorkspaceConfig(JSON.parse(configJson));
  } catch {
    return {};
  }
}

const offlinegptWorkspaceConfigStore = createWorkspaceKvStore<Record<string, unknown>>({
  tableName: "offlinegpt_workspace_configs",
  valueColumn: "config_json",
  parse: parseOfflineGptWorkspaceConfig,
  serialize: (value) => JSON.stringify(value),
});

export async function readOfflineGptWorkspaceConfig(config: ServerConfig, workspaceId: string): Promise<Record<string, unknown>> {
  return await offlinegptWorkspaceConfigStore.get(config, workspaceId) ?? {};
}

export async function writeOfflineGptWorkspaceConfig(
  config: ServerConfig,
  workspaceId: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const next = normalizeOfflineGptWorkspaceConfig(updater(await readOfflineGptWorkspaceConfig(config, workspaceId)));
  await offlinegptWorkspaceConfigStore.set(config, workspaceId, next);
  return next;
}

export async function hasOfflineGptWorkspaceConfig(
  config: ServerConfig,
  workspaceId: string,
): Promise<boolean> {
  return offlinegptWorkspaceConfigStore.has(config, workspaceId);
}

/**
 * Seed the DB-backed offlinegpt config for a workspace if no row exists yet.
 * Used at workspace creation and as the migrate-on-read landing spot for
 * legacy `.opencode/offlinegpt.json` files. No-op when a row is already present,
 * so it never clobbers live provisioning state.
 */
export async function seedOfflineGptWorkspaceConfigIfEmpty(
  config: ServerConfig,
  workspaceId: string,
  seed: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (await hasOfflineGptWorkspaceConfig(config, workspaceId)) {
    return readOfflineGptWorkspaceConfig(config, workspaceId);
  }
  return writeOfflineGptWorkspaceConfig(config, workspaceId, () => seed);
}

export function mergeOfflineGptWorkspaceConfigs(
  legacy: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  return { ...legacy, ...stored };
}
