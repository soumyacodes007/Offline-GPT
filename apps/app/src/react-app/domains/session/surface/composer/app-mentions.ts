import { OFFLINEGPT_EXTENSION_CATALOG } from "@/app/constants";
import { desktopBridge } from "@/app/lib/desktop";
import { isOfflineGPTExtensionEnabled, isOfflineGPTExtensionHidden } from "@/react-app/domains/settings/extension-state";

/**
 * "@App" mentions let the user target a running app for Computer Use straight
 * from the composer (e.g. "@Music"). They are only offered in the desktop app
 * while the Computer Use (Cua Driver) extension is enabled.
 */
export function isAppMentionAvailable(): boolean {
  if (typeof window === "undefined" || !window.__OFFLINEGPT_ELECTRON__?.invokeDesktop) return false;
  const entry = OFFLINEGPT_EXTENSION_CATALOG.find((candidate) => candidate.id === "computer-use");
  if (!entry) return false;
  return isOfflineGPTExtensionEnabled(entry) && !isOfflineGPTExtensionHidden(entry);
}

/**
 * Instruction text sent to the model for a composer "@App" mention. Steers the
 * agent to the Cua Driver MCP tools and the cua-driver skill instead of
 * assuming the app is frontmost.
 */
export function appMentionInstruction(appName: string) {
  return `[The user mentioned the app ${JSON.stringify(appName)}. Prefer a dedicated app integration when available. For Computer Use, follow the cua-driver skill: resolve the app with the Cua Driver (computer-use MCP) list_apps and list_windows tools, observe one exact window with a targeted get_window_state, act on fresh element_token values (with run_steps when the driver advertises it, otherwise click and type_text), and verify the outcome with verify_state or a fresh read. Use only tools the connected driver lists. A mention is a target, not a permission grant: keep actions in the background unless the user authorized foreground control, and never treat an unverifiable result as success.]`;
}

type ListRunningAppsResult = { ok?: boolean; apps?: unknown };

let appsCache: { at: number; apps: string[] } | null = null;
const APPS_CACHE_TTL_MS = 10_000;

/** Running apps from Cua Driver for the mention menu. Cached briefly; never throws. */
export async function listRunningAppsForMention(): Promise<string[]> {
  if (!isAppMentionAvailable()) return [];
  if (appsCache && Date.now() - appsCache.at < APPS_CACHE_TTL_MS) return appsCache.apps;
  try {
    const result: ListRunningAppsResult = await desktopBridge.listRunningApps();
    const apps = Array.isArray(result.apps)
      ? result.apps.filter((name): name is string => typeof name === "string" && name.trim().length > 0)
      : [];
    appsCache = { at: Date.now(), apps };
    return apps;
  } catch {
    return [];
  }
}
