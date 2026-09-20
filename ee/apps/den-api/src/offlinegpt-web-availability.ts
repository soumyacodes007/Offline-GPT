import { env } from "./env.js"
import { hasOfflineGPTWebComplimentaryAccess } from "./offlinegpt-web-access.js"

export function offlineGptWebDeploymentAvailable(enabled: boolean) {
  return enabled === true
}

export function isOfflineGPTWebAvailable() {
  return offlineGptWebDeploymentAvailable(env.offlinegptWebEnabled)
}

export function offlineGptWebAvailableForOrganization(
  enabled: boolean,
  metadata: Record<string, unknown> | string | null | undefined,
) {
  return offlineGptWebDeploymentAvailable(enabled) || hasOfflineGPTWebComplimentaryAccess(metadata)
}

export function isOfflineGPTWebAvailableForOrganization(
  metadata: Record<string, unknown> | string | null | undefined,
) {
  return offlineGptWebAvailableForOrganization(env.offlinegptWebEnabled, metadata)
}
