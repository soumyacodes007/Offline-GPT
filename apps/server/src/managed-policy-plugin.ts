import { offlinegptPluginPath } from "./offlinegpt-extensions-plugin-path.js";
export function managedPolicyPluginPath(next = false): string {
  return offlinegptPluginPath(next ? "managed-policy-next" : "managed-policy");
}
