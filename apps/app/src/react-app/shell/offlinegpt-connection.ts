import {
  getOfflineGptGatewayOrigin,
  readOfflineGptGatewayDenToken,
} from "../../app/lib/gateway-runtime";
import {
  isLoopbackOfflineGptServerUrl,
  normalizeOfflineGptServerUrl,
  readOfflineGptServerSettings,
} from "../../app/lib/offlinegpt-server";
import { isWebDeployment } from "../../app/lib/offlinegpt-deployment";
import { offlinegptServerInfo, type OfflineGptServerInfo } from "../../app/lib/desktop";
import { isDesktopRuntime } from "../../app/utils";

export type OfflineGptConnectionSource = "desktop-runtime" | "stored-settings" | "same-origin" | "gateway" | "empty";

export type ResolvedOfflineGptConnection = {
  normalizedBaseUrl: string;
  resolvedToken: string;
  resolvedHostToken: string;
  hostInfo: OfflineGptServerInfo | null;
  source: OfflineGptConnectionSource;
};

function hasUsableConnection(url: string, token: string) {
  return url.trim().length > 0 && token.trim().length > 0;
}

/**
 * Stored settings for a desktop-managed local server are snapshots of
 * ephemeral state: the server mints a fresh loopback port and tokens on every
 * (re)start. When the live desktop runtime definitively reports that the
 * server is not ready, any stored loopback connection is from a previous
 * server lifetime — resolving it would point the route at a dead port and
 * make a restart look like a broken connection instead of a transient gap.
 * Stored non-loopback URLs (remote/manual servers) stay usable as fallbacks,
 * and a failing desktop bridge (no definitive answer) keeps today's fallback
 * behavior.
 */
export function isStaleStoredDesktopConnection(input: {
  desktopRuntime: boolean;
  desktopServerReportedNotReady: boolean;
  storedBaseUrl: string;
  runtimeReportedBaseUrl: string;
}): boolean {
  if (!input.desktopRuntime || !input.desktopServerReportedNotReady) return false;
  if (!input.storedBaseUrl) return false;
  return (
    isLoopbackOfflineGptServerUrl(input.storedBaseUrl) ||
    input.storedBaseUrl === input.runtimeReportedBaseUrl
  );
}

/**
 * Resolve the OfflineGPT server connection for routes that consume the server API.
 *
 * Local desktop-hosted servers expose ephemeral loopback ports and freshly
 * minted tokens on every boot, so live runtime info is the source of truth
 * there. Stored settings remain the fallback for remote/manual server
 * connections and for desktop cases where the runtime bridge is unavailable.
 */
export async function resolveOfflineGptConnection(): Promise<ResolvedOfflineGptConnection> {
  const gatewayOrigin = getOfflineGptGatewayOrigin();
  if (gatewayOrigin) {
    return {
      normalizedBaseUrl: normalizeOfflineGptServerUrl(gatewayOrigin) ?? "",
      resolvedToken: readOfflineGptGatewayDenToken(),
      resolvedHostToken: "",
      hostInfo: null,
      source: "gateway",
    };
  }

  let staleDesktopRuntimeBaseUrl = "";
  let desktopServerReportedNotReady = false;

  if (isDesktopRuntime()) {
    try {
      const info = await offlinegptServerInfo() as OfflineGptServerInfo;
      const normalizedBaseUrl =
        normalizeOfflineGptServerUrl(info.baseUrl ?? info.connectUrl ?? info.lanUrl ?? info.mdnsUrl ?? "") ??
        "";
      const resolvedToken = info.ownerToken?.trim() || info.clientToken?.trim() || "";
      if (info.running === true && hasUsableConnection(normalizedBaseUrl, resolvedToken)) {
        return {
          normalizedBaseUrl,
          resolvedToken,
          resolvedHostToken: info.hostToken?.trim() || "",
          hostInfo: info,
          source: "desktop-runtime",
        };
      }
      // Definitive live answer: the local server is booting/restarting and
      // has not republished a usable connection yet.
      desktopServerReportedNotReady = true;
      staleDesktopRuntimeBaseUrl = normalizedBaseUrl;
    } catch {
      // Fall through to stored settings for remote/manual connections.
    }
  }

  const settings = readOfflineGptServerSettings();
  const normalizedBaseUrl = normalizeOfflineGptServerUrl(settings.urlOverride ?? "") ?? "";
  const sameOriginBaseUrl =
    !normalizedBaseUrl && !isDesktopRuntime() && isWebDeployment() && typeof window !== "undefined"
      ? normalizeOfflineGptServerUrl(window.location.origin) ?? ""
      : "";
  const resolvedToken = settings.token?.trim() ?? "";
  const resolvedHostToken =
    normalizedBaseUrl && isLoopbackOfflineGptServerUrl(normalizedBaseUrl)
      ? settings.hostToken?.trim() ?? ""
      : "";
  const storedConnectionIsStaleDesktopRuntime = isStaleStoredDesktopConnection({
    desktopRuntime: isDesktopRuntime(),
    desktopServerReportedNotReady,
    storedBaseUrl: normalizedBaseUrl,
    runtimeReportedBaseUrl: staleDesktopRuntimeBaseUrl,
  });
  const source =
    !storedConnectionIsStaleDesktopRuntime && hasUsableConnection(normalizedBaseUrl, resolvedToken)
      ? "stored-settings"
      : hasUsableConnection(sameOriginBaseUrl, resolvedToken)
        ? "same-origin"
        : "empty";

  return {
    normalizedBaseUrl: source === "same-origin"
      ? sameOriginBaseUrl
      : source === "empty"
        ? ""
        : normalizedBaseUrl,
    resolvedToken: source === "empty" ? "" : resolvedToken,
    resolvedHostToken: source === "empty" ? "" : resolvedHostToken,
    hostInfo: null,
    source,
  };
}
