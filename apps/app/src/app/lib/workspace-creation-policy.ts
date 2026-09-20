import { isOfflineGptGatewayRuntime } from "./gateway-runtime";

export function canCreateWorkspaces() {
  return !isOfflineGptGatewayRuntime();
}
