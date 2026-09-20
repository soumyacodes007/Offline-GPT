import { useSyncExternalStore } from "react";

import { t } from "../../../i18n";
import type { StartupPreference, WorkspaceDisplay } from "../../../app/types";
import { isDesktopRuntime } from "../../../app/utils";
import {
  offlinegptServerInfo,
  offlinegptServerRestart,
  type OfflineGptServerInfo,
} from "../../../app/lib/desktop";
import {
  getOfflineGptGatewayOrigin,
  readOfflineGptGatewayDenToken,
} from "../../../app/lib/gateway-runtime";
import {
  clearOfflineGptServerSettings,
  createOfflineGptServerClient,
  isLoopbackOfflineGptServerUrl,
  normalizeOfflineGptServerUrl,
  readOfflineGptServerSettings,
  writeOfflineGptServerSettings,
  type OfflineGptAuditEntry,
  type OfflineGptServerCapabilities,
  type OfflineGptServerClient,
  type OfflineGptServerDiagnostics,
  type OfflineGptServerError,
  type OfflineGptServerSettings,
  type OfflineGptServerStatus,
} from "../../../app/lib/offlinegpt-server";

type SetStateAction<T> = T | ((current: T) => T);

type RemoteWorkspaceInput = {
  offlinegptHostUrl: string;
  offlinegptToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
};

export type OfflineGptServerStoreSnapshot = {
  offlinegptServerSettings: OfflineGptServerSettings;
  shareRemoteAccessBusy: boolean;
  shareRemoteAccessError: string | null;
  offlinegptServerUrl: string;
  offlinegptServerBaseUrl: string;
  offlinegptServerAuth: { token?: string; hostToken?: string };
  offlinegptServerClient: OfflineGptServerClient | null;
  offlinegptServerStatus: OfflineGptServerStatus;
  offlinegptServerCapabilities: OfflineGptServerCapabilities | null;
  offlinegptServerReady: boolean;
  offlinegptServerWorkspaceReady: boolean;
  resolvedOfflineGptCapabilities: OfflineGptServerCapabilities | null;
  offlinegptServerCanWriteSkills: boolean;
  offlinegptServerCanWritePlugins: boolean;
  offlinegptServerHostInfo: OfflineGptServerInfo | null;
  offlinegptServerDiagnostics: OfflineGptServerDiagnostics | null;
  offlinegptReconnectBusy: boolean;
  offlinegptAuditEntries: OfflineGptAuditEntry[];
  offlinegptAuditStatus: "idle" | "loading" | "error";
  offlinegptAuditError: string | null;
  devtoolsWorkspaceId: string | null;
};

export type OfflineGptServerStore = ReturnType<typeof createOfflineGptServerStore>;

type CreateOfflineGptServerStoreOptions = {
  startupPreference: () => StartupPreference | null;
  documentVisible: () => boolean;
  developerMode: () => boolean;
  runtimeWorkspaceId: () => string | null;
  activeClient: () => unknown | null;
  selectedWorkspaceDisplay: () => WorkspaceDisplay;
  restartLocalServer: () => Promise<boolean>;
  createRemoteWorkspaceFlow: (input: RemoteWorkspaceInput) => Promise<boolean>;
};

type MutableState = {
  offlinegptServerSettings: OfflineGptServerSettings;
  shareRemoteAccessBusy: boolean;
  shareRemoteAccessError: string | null;
  offlinegptServerUrl: string;
  offlinegptServerStatus: OfflineGptServerStatus;
  offlinegptServerCapabilities: OfflineGptServerCapabilities | null;
  offlinegptServerCheckedAt: number | null;
  offlinegptServerHostInfo: OfflineGptServerInfo | null;
  offlinegptServerHostInfoReady: boolean;
  offlinegptServerDiagnostics: OfflineGptServerDiagnostics | null;
  offlinegptReconnectBusy: boolean;
  offlinegptAuditEntries: OfflineGptAuditEntry[];
  offlinegptAuditStatus: "idle" | "loading" | "error";
  offlinegptAuditError: string | null;
  devtoolsWorkspaceId: string | null;
};

const applyStateAction = <T,>(current: T, next: SetStateAction<T>) =>
  typeof next === "function" ? (next as (value: T) => T)(current) : next;

function sameOfflineGptServerSnapshot(
  current: OfflineGptServerStoreSnapshot,
  next: OfflineGptServerStoreSnapshot,
): boolean {
  return (
    current.offlinegptServerSettings === next.offlinegptServerSettings &&
    current.shareRemoteAccessBusy === next.shareRemoteAccessBusy &&
    current.shareRemoteAccessError === next.shareRemoteAccessError &&
    current.offlinegptServerUrl === next.offlinegptServerUrl &&
    current.offlinegptServerBaseUrl === next.offlinegptServerBaseUrl &&
    current.offlinegptServerAuth.token === next.offlinegptServerAuth.token &&
    current.offlinegptServerAuth.hostToken === next.offlinegptServerAuth.hostToken &&
    current.offlinegptServerClient === next.offlinegptServerClient &&
    current.offlinegptServerStatus === next.offlinegptServerStatus &&
    current.offlinegptServerCapabilities === next.offlinegptServerCapabilities &&
    current.offlinegptServerReady === next.offlinegptServerReady &&
    current.offlinegptServerWorkspaceReady === next.offlinegptServerWorkspaceReady &&
    current.resolvedOfflineGptCapabilities === next.resolvedOfflineGptCapabilities &&
    current.offlinegptServerCanWriteSkills === next.offlinegptServerCanWriteSkills &&
    current.offlinegptServerCanWritePlugins === next.offlinegptServerCanWritePlugins &&
    current.offlinegptServerHostInfo === next.offlinegptServerHostInfo &&
    current.offlinegptServerDiagnostics === next.offlinegptServerDiagnostics &&
    current.offlinegptReconnectBusy === next.offlinegptReconnectBusy &&
    current.offlinegptAuditEntries === next.offlinegptAuditEntries &&
    current.offlinegptAuditStatus === next.offlinegptAuditStatus &&
    current.offlinegptAuditError === next.offlinegptAuditError &&
    current.devtoolsWorkspaceId === next.devtoolsWorkspaceId
  );
}

export function createOfflineGptServerStore(options: CreateOfflineGptServerStoreOptions) {
  const bootStartedAt = Date.now();
  const listeners = new Set<() => void>();
  const intervals = new Map<string, number>();

  let clientCacheKey = "";
  let clientCacheValue: OfflineGptServerClient | null = null;
  let started = false;
  let disposed = false;
  let healthTimeoutId: number | null = null;
  let healthBusy = false;
  let healthDelayMs = 10_000;
  let consecutiveHealthFailures = 0;
  let visibilityChangeHandler: (() => void) | null = null;
  let snapshot: OfflineGptServerStoreSnapshot | undefined;

  let state: MutableState = {
    offlinegptServerSettings: readOfflineGptServerSettings(),
    shareRemoteAccessBusy: false,
    shareRemoteAccessError: null,
    offlinegptServerUrl: "",
    offlinegptServerStatus: "disconnected",
    offlinegptServerCapabilities: null,
    offlinegptServerCheckedAt: null,
    offlinegptServerHostInfo: null,
    offlinegptServerHostInfoReady: !isDesktopRuntime(),
    offlinegptServerDiagnostics: null,
    offlinegptReconnectBusy: false,
    offlinegptAuditEntries: [],
    offlinegptAuditStatus: "idle",
    offlinegptAuditError: null,
    devtoolsWorkspaceId: null,
  };

  const emitChange = () => {
    for (const listener of listeners) listener();
  };

  const getBaseUrl = () => {
    const gatewayOrigin = getOfflineGptGatewayOrigin();
    if (gatewayOrigin) return normalizeOfflineGptServerUrl(gatewayOrigin) ?? "";

    const pref = options.startupPreference();
    const hostInfo = state.offlinegptServerHostInfo;
    const settingsUrl = normalizeOfflineGptServerUrl(state.offlinegptServerSettings.urlOverride ?? "") ?? "";

    if (pref === "local") return hostInfo?.baseUrl ?? "";
    if (pref === "server" && settingsUrl && isLoopbackOfflineGptServerUrl(settingsUrl) && hostInfo?.baseUrl) {
      return hostInfo.baseUrl;
    }
    if (pref === "server") return settingsUrl;
    return hostInfo?.baseUrl ?? settingsUrl;
  };

  const getAuth = () => {
    const gatewayOrigin = getOfflineGptGatewayOrigin();
    if (gatewayOrigin) {
      const token = readOfflineGptGatewayDenToken().trim();
      return { token: token || undefined, hostToken: undefined };
    }

    const pref = options.startupPreference();
    const hostInfo = state.offlinegptServerHostInfo;
    const settingsUrl = normalizeOfflineGptServerUrl(state.offlinegptServerSettings.urlOverride ?? "") ?? "";
    const settingsToken = state.offlinegptServerSettings.token?.trim() ?? "";
    const settingsHostToken = state.offlinegptServerSettings.hostToken?.trim() ?? "";
    const clientToken = hostInfo?.clientToken?.trim() ?? "";
    const hostToken = hostInfo?.hostToken?.trim() ?? "";

    if (pref === "local") {
      return { token: clientToken || undefined, hostToken: hostToken || undefined };
    }
    if (pref === "server" && settingsUrl && isLoopbackOfflineGptServerUrl(settingsUrl) && hostInfo?.baseUrl) {
      return {
        token: clientToken || settingsToken || undefined,
        hostToken: hostToken || settingsHostToken || undefined,
      };
    }
    if (pref === "server") {
      return {
        token: settingsToken || undefined,
        hostToken: settingsUrl && isLoopbackOfflineGptServerUrl(settingsUrl) ? settingsHostToken || undefined : undefined,
      };
    }
    if (hostInfo?.baseUrl) {
      return { token: clientToken || undefined, hostToken: hostToken || undefined };
    }
    return {
      token: settingsToken || undefined,
      hostToken: settingsUrl && isLoopbackOfflineGptServerUrl(settingsUrl) ? settingsHostToken || undefined : undefined,
    };
  };

  const getClient = () => {
    const baseUrl = getBaseUrl().trim();
    if (!baseUrl) {
      clientCacheKey = "";
      clientCacheValue = null;
      return null;
    }

    const auth = getAuth();
    const key = `${baseUrl}::${auth.token ?? ""}::${auth.hostToken ?? ""}`;
    if (key !== clientCacheKey) {
      clientCacheKey = key;
      clientCacheValue = createOfflineGptServerClient({
        baseUrl,
        token: auth.token,
        hostToken: auth.hostToken,
      });
    }
    return clientCacheValue;
  };

  const refreshSnapshot = (): boolean => {
    const offlinegptServerBaseUrl = getBaseUrl().trim();
    const offlinegptServerAuth = getAuth();
    const offlinegptServerClient = getClient();
    const offlinegptServerReady = state.offlinegptServerStatus === "connected";
    const offlinegptServerWorkspaceReady = Boolean(options.runtimeWorkspaceId());
    const resolvedOfflineGptCapabilities = state.offlinegptServerCapabilities;

    const pref = options.startupPreference();
    const info = state.offlinegptServerHostInfo;
    const hostUrl = info?.connectUrl ?? info?.lanUrl ?? info?.mdnsUrl ?? info?.baseUrl ?? "";
    const settingsUrl = normalizeOfflineGptServerUrl(state.offlinegptServerSettings.urlOverride ?? "") ?? "";

    let offlinegptServerUrl = hostUrl || settingsUrl;
    if (pref === "local") offlinegptServerUrl = hostUrl;
    if (pref === "server") offlinegptServerUrl = settingsUrl;
    state.offlinegptServerUrl = offlinegptServerUrl;

    const nextSnapshot: OfflineGptServerStoreSnapshot = {
      offlinegptServerSettings: state.offlinegptServerSettings,
      shareRemoteAccessBusy: state.shareRemoteAccessBusy,
      shareRemoteAccessError: state.shareRemoteAccessError,
      offlinegptServerUrl,
      offlinegptServerBaseUrl,
      offlinegptServerAuth,
      offlinegptServerClient,
      offlinegptServerStatus: state.offlinegptServerStatus,
      offlinegptServerCapabilities: state.offlinegptServerCapabilities,
      offlinegptServerReady,
      offlinegptServerWorkspaceReady,
      resolvedOfflineGptCapabilities,
      offlinegptServerCanWriteSkills:
        offlinegptServerReady &&
        (resolvedOfflineGptCapabilities?.skills?.write ?? false),
      offlinegptServerCanWritePlugins:
        offlinegptServerReady &&
        (resolvedOfflineGptCapabilities?.plugins?.write ?? false),
      offlinegptServerHostInfo: state.offlinegptServerHostInfo,
      offlinegptServerDiagnostics: state.offlinegptServerDiagnostics,
      offlinegptReconnectBusy: state.offlinegptReconnectBusy,
      offlinegptAuditEntries: state.offlinegptAuditEntries,
      offlinegptAuditStatus: state.offlinegptAuditStatus,
      offlinegptAuditError: state.offlinegptAuditError,
      devtoolsWorkspaceId: state.devtoolsWorkspaceId,
    };
    if (snapshot && sameOfflineGptServerSnapshot(snapshot, nextSnapshot)) return false;
    snapshot = nextSnapshot;
    return true;
  };

  const mutateState = (updater: (current: MutableState) => MutableState) => {
    state = updater(state);
    if (refreshSnapshot()) emitChange();
  };

  const setStateField = <K extends keyof MutableState>(key: K, value: MutableState[K]) => {
    if (Object.is(state[key], value)) return;
    mutateState((current) => ({ ...current, [key]: value }));
  };

  const setOfflineGptServerSettings = (next: SetStateAction<OfflineGptServerSettings>) => {
    const resolved = applyStateAction(state.offlinegptServerSettings, next);
    mutateState((current) => ({ ...current, offlinegptServerSettings: resolved }));
    queueHealthCheck(0);
  };

  const updateOfflineGptServerSettings = (next: OfflineGptServerSettings) => {
    const stored = writeOfflineGptServerSettings(next);
    mutateState((current) => ({ ...current, offlinegptServerSettings: stored }));
    queueHealthCheck(0);
  };

  const resetOfflineGptServerSettings = () => {
    clearOfflineGptServerSettings();
    mutateState((current) => ({ ...current, offlinegptServerSettings: {} }));
    queueHealthCheck(0);
  };

  const shouldWaitForLocalHostInfo = () =>
    isDesktopRuntime() &&
    options.startupPreference() !== "server" &&
    !state.offlinegptServerHostInfoReady;

  const shouldRetryStartupCheck = (status: OfflineGptServerStatus) =>
    status !== "connected" &&
    isDesktopRuntime() &&
    options.startupPreference() !== "server" &&
    Date.now() - bootStartedAt < 5_000;

  const checkOfflineGptServer = async (url: string, token?: string, hostToken?: string) => {
    const client = createOfflineGptServerClient({ baseUrl: url, token, hostToken });
    try {
      await client.health();
    } catch (error) {
      const resolved = error as OfflineGptServerError | Error;
      if ("status" in resolved && (resolved.status === 401 || resolved.status === 403)) {
        return { status: "limited" as OfflineGptServerStatus, capabilities: null };
      }
      return { status: "disconnected" as OfflineGptServerStatus, capabilities: null };
    }

    if (!token) {
      return { status: "limited" as OfflineGptServerStatus, capabilities: null };
    }

    try {
      const capabilities = await client.capabilities();
      return { status: "connected" as OfflineGptServerStatus, capabilities };
    } catch (error) {
      const resolved = error as OfflineGptServerError | Error;
      if ("status" in resolved && (resolved.status === 401 || resolved.status === 403)) {
        return { status: "limited" as OfflineGptServerStatus, capabilities: null };
      }
      return { status: "disconnected" as OfflineGptServerStatus, capabilities: null };
    }
  };

  const clearHealthTimeout = () => {
    if (healthTimeoutId !== null) {
      window.clearTimeout(healthTimeoutId);
      healthTimeoutId = null;
    }
  };

  const queueHealthCheck = (delayMs: number) => {
    if (disposed || typeof window === "undefined") return;
    clearHealthTimeout();
    healthTimeoutId = window.setTimeout(() => {
      healthTimeoutId = null;
      void runHealthCheck();
    }, Math.max(0, delayMs));
  };

  const runHealthCheck = async () => {
    if (disposed || typeof window === "undefined") return;
    if (!options.documentVisible()) {
      queueHealthCheck(healthDelayMs);
      return;
    }
    if (shouldWaitForLocalHostInfo()) {
      queueHealthCheck(250);
      return;
    }
    if (healthBusy) return;

    const url = getBaseUrl().trim();
    const auth = getAuth();
    if (!url) {
      consecutiveHealthFailures = 0;
      mutateState((current) => ({
        ...current,
        offlinegptServerStatus: "disconnected",
        offlinegptServerCapabilities: null,
        offlinegptServerCheckedAt: Date.now(),
      }));
      return;
    }

    healthBusy = true;
    try {
      let result = await checkOfflineGptServer(url, auth.token, auth.hostToken);

      if (shouldRetryStartupCheck(result.status)) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
        if (disposed) return;

        try {
          const info = await offlinegptServerInfo() as OfflineGptServerInfo;
          if (disposed) return;

          mutateState((current) => ({
            ...current,
            offlinegptServerHostInfo: info,
            offlinegptServerHostInfoReady: true,
          }));

          const retryUrl = info.baseUrl?.trim() ?? "";
          const retryToken = info.clientToken?.trim() || undefined;
          const retryHostToken = info.hostToken?.trim() || undefined;
          if (retryUrl) {
            result = await checkOfflineGptServer(retryUrl, retryToken, retryHostToken);
          }
        } catch {
          // Preserve the original check result when the retry probe fails.
        }
      }

      if (disposed) return;
      const previousStatus = state.offlinegptServerStatus;
      const previousCapabilities = state.offlinegptServerCapabilities;
      const healthy = result.status === "connected" || result.status === "limited";
      if (healthy) {
        consecutiveHealthFailures = 0;
        healthDelayMs = 10_000;
      } else {
        consecutiveHealthFailures += 1;
        healthDelayMs = Math.min(healthDelayMs * 2, 60_000);
      }

      const preservePrevious =
        !healthy &&
        consecutiveHealthFailures < 3 &&
        (previousStatus === "connected" || previousStatus === "limited");

      mutateState((current) => ({
        ...current,
        offlinegptServerStatus: preservePrevious ? previousStatus : result.status,
        offlinegptServerCapabilities: preservePrevious ? previousCapabilities : result.capabilities,
        offlinegptServerCheckedAt: Date.now(),
      }));
    } catch {
      healthDelayMs = Math.min(healthDelayMs * 2, 60_000);
      mutateState((current) => ({
        ...current,
        offlinegptServerCheckedAt: Date.now(),
      }));
    } finally {
      healthBusy = false;
      if (!disposed) queueHealthCheck(healthDelayMs);
    }
  };

  const syncFromOptions = () => {
    if (refreshSnapshot()) emitChange();

    if (!isDesktopRuntime()) return;
    const port = state.offlinegptServerHostInfo?.port;
    if (!port) return;
    if (state.offlinegptServerSettings.portOverride === port) return;

    updateOfflineGptServerSettings({
      ...state.offlinegptServerSettings,
      portOverride: port,
    });
  };

  const startInterval = (key: string, fn: () => void, ms: number) => {
    if (typeof window === "undefined") return;
    if (intervals.has(key)) return;
    intervals.set(key, window.setInterval(fn, ms));
  };

  const stopInterval = (key: string) => {
    const id = intervals.get(key);
    if (id === undefined) return;
    window.clearInterval(id);
    intervals.delete(key);
  };

  const start = () => {
    if (typeof window === "undefined") return;
    if (started) return;
    // Allow restart after a prior dispose() (React 18 StrictMode double-mounts
    // each effect in dev: mount → dispose → re-mount). If we early-return when
    // `disposed` is true, the real mount never arms polling and the UI stays
    // on stale/empty state forever.
    disposed = false;
    started = true;

    syncFromOptions();
    queueHealthCheck(0);
    visibilityChangeHandler = () => {
      if (!options.documentVisible()) return;
      consecutiveHealthFailures = 0;
      queueHealthCheck(0);
    };
    window.addEventListener("visibilitychange", visibilityChangeHandler);

    const refreshHostInfo = () => {
      if (!isDesktopRuntime()) return;
      if (!options.documentVisible()) return;
      void (async () => {
        try {
          const info = await offlinegptServerInfo() as OfflineGptServerInfo;
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            offlinegptServerHostInfo: info,
            offlinegptServerHostInfoReady: true,
          }));
        } catch {
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            offlinegptServerHostInfo: null,
            offlinegptServerHostInfoReady: true,
          }));
        }
      })();
    };
    refreshHostInfo();
    startInterval("hostInfo", refreshHostInfo, 10_000);

    const refreshDiagnostics = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        setStateField("offlinegptServerDiagnostics", null);
        return;
      }

      const client = getClient();
      if (!client || state.offlinegptServerStatus === "disconnected") {
        setStateField("offlinegptServerDiagnostics", null);
        return;
      }

      void (async () => {
        try {
          const status = await client.status();
          if (!disposed) setStateField("offlinegptServerDiagnostics", status);
        } catch {
          if (!disposed) setStateField("offlinegptServerDiagnostics", null);
        }
      })();
    };
    refreshDiagnostics();
    startInterval("diagnostics", refreshDiagnostics, 10_000);

    const refreshDevtoolsWorkspace = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        setStateField("devtoolsWorkspaceId", null);
        return;
      }

      const client = getClient();
      if (!client) {
        setStateField("devtoolsWorkspaceId", null);
        return;
      }

      void (async () => {
        try {
          const response = await client.listWorkspaces();
          if (disposed) return;
          const items = Array.isArray(response.items) ? response.items : [];
          const activeMatch = response.activeId
            ? items.find((item) => item.id === response.activeId)
            : null;
          setStateField("devtoolsWorkspaceId", activeMatch?.id ?? items[0]?.id ?? null);
        } catch {
          if (!disposed) setStateField("devtoolsWorkspaceId", null);
        }
      })();
    };
    refreshDevtoolsWorkspace();
    startInterval("devtoolsWorkspace", refreshDevtoolsWorkspace, 20_000);

    const refreshAudit = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        mutateState((current) => ({
          ...current,
          offlinegptAuditEntries: [],
          offlinegptAuditStatus: "idle",
          offlinegptAuditError: null,
        }));
        return;
      }

      const client = getClient();
      const workspaceId = state.devtoolsWorkspaceId;
      if (!client || !workspaceId) {
        mutateState((current) => ({
          ...current,
          offlinegptAuditEntries: [],
          offlinegptAuditStatus: "idle",
          offlinegptAuditError: null,
        }));
        return;
      }

      mutateState((current) => ({
        ...current,
        offlinegptAuditStatus: "loading",
        offlinegptAuditError: null,
      }));

      void (async () => {
        try {
          const result = await client.listAudit(workspaceId, 50);
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            offlinegptAuditEntries: Array.isArray(result.items) ? result.items : [],
            offlinegptAuditStatus: "idle",
          }));
        } catch (error) {
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            offlinegptAuditEntries: [],
            offlinegptAuditStatus: "error",
            offlinegptAuditError:
              error instanceof Error
                ? error.message
                : t("app.error_audit_load"),
          }));
        }
      })();
    };
    refreshAudit();
    startInterval("audit", refreshAudit, 15_000);
  };

  const dispose = () => {
    disposed = true;
    started = false;
    clearHealthTimeout();
    if (visibilityChangeHandler && typeof window !== "undefined") {
      window.removeEventListener("visibilitychange", visibilityChangeHandler);
      visibilityChangeHandler = null;
    }
    for (const key of [...intervals.keys()]) stopInterval(key);
  };

  const testOfflineGptServerConnection = async (next: OfflineGptServerSettings) => {
    const derived = normalizeOfflineGptServerUrl(next.urlOverride ?? "");
    if (!derived) {
      mutateState((current) => ({
        ...current,
        offlinegptServerStatus: "disconnected",
        offlinegptServerCapabilities: null,
        offlinegptServerCheckedAt: Date.now(),
      }));
      return false;
    }

    const result = await checkOfflineGptServer(derived, next.token);
    consecutiveHealthFailures = result.status === "disconnected" ? consecutiveHealthFailures + 1 : 0;
    mutateState((current) => ({
      ...current,
      offlinegptServerStatus: result.status,
      offlinegptServerCapabilities: result.capabilities,
      offlinegptServerCheckedAt: Date.now(),
    }));

    const ok = result.status === "connected" || result.status === "limited";
    if (ok && !isDesktopRuntime()) {
      const active = options.selectedWorkspaceDisplay();
      const shouldAttach =
        !options.activeClient() ||
        active.workspaceType !== "remote" ||
        active.remoteType !== "offlinegpt";
      if (shouldAttach) {
        await options
          .createRemoteWorkspaceFlow({
            offlinegptHostUrl: derived,
            offlinegptToken: next.token ?? null,
          })
          .catch(() => undefined);
      }
    }
    return ok;
  };

  const reconnectOfflineGptServer = async () => {
    if (state.offlinegptReconnectBusy) return false;
    setStateField("offlinegptReconnectBusy", true);

    try {
      let hostInfo = state.offlinegptServerHostInfo;
      if (isDesktopRuntime()) {
        try {
          hostInfo = await offlinegptServerInfo() as OfflineGptServerInfo;
          mutateState((current) => ({ ...current, offlinegptServerHostInfo: hostInfo }));
        } catch {
          hostInfo = null;
          setStateField("offlinegptServerHostInfo", null);
        }
      }

      if (hostInfo?.clientToken?.trim() && options.startupPreference() !== "server") {
        const liveToken = hostInfo.clientToken.trim();
        const liveHostToken = hostInfo.hostToken?.trim() ?? "";
        const settings = state.offlinegptServerSettings;
        if (
          (settings.token?.trim() ?? "") !== liveToken ||
          (settings.hostToken?.trim() ?? "") !== liveHostToken
        ) {
          updateOfflineGptServerSettings({
            ...settings,
            token: liveToken,
            hostToken: liveHostToken || undefined,
          });
        }
      }

      const url = getBaseUrl().trim();
      const auth = getAuth();
      if (!url) {
        mutateState((current) => ({
          ...current,
          offlinegptServerStatus: "disconnected",
          offlinegptServerCapabilities: null,
          offlinegptServerCheckedAt: Date.now(),
        }));
        return false;
      }

      const result = await checkOfflineGptServer(url, auth.token, auth.hostToken);
      mutateState((current) => ({
        ...current,
        offlinegptServerStatus: result.status,
        offlinegptServerCapabilities: result.capabilities,
        offlinegptServerCheckedAt: Date.now(),
      }));
      return result.status === "connected" || result.status === "limited";
    } finally {
      setStateField("offlinegptReconnectBusy", false);
    }
  };

  async function ensureLocalOfflineGptServerClient(): Promise<OfflineGptServerClient | null> {
    const healthyClientFromInfo = async (
      info: OfflineGptServerInfo | null,
    ): Promise<OfflineGptServerClient | null> => {
      const baseUrl = info?.baseUrl?.trim() ?? "";
      const token = info?.clientToken?.trim() ?? "";
      if (!baseUrl || !token) return null;
      const candidate = createOfflineGptServerClient({
        baseUrl,
        token,
        hostToken: info?.hostToken?.trim() || undefined,
      });
      try {
        await candidate.health();
      } catch {
        return null;
      }
      return candidate;
    };

    const cached = await healthyClientFromInfo(state.offlinegptServerHostInfo);
    if (cached) {
      if (options.startupPreference() !== "server") {
        await reconnectOfflineGptServer();
      }
      return cached;
    }

    if (!isDesktopRuntime()) return null;

    // A store that has not observed the server yet (a fresh route mount)
    // must not treat it as dead: the restart below tears down the embedded
    // server AND its managed engine, killing every live run. Ask the desktop
    // bridge for the live server first and restart only when that running
    // server is genuinely unreachable.
    let hostInfo: OfflineGptServerInfo | null = null;
    try {
      hostInfo = await offlinegptServerInfo() as OfflineGptServerInfo;
      mutateState((current) => ({
        ...current,
        offlinegptServerHostInfo: hostInfo,
        offlinegptServerHostInfoReady: true,
      }));
    } catch {
      hostInfo = null;
    }
    const live = await healthyClientFromInfo(hostInfo);
    if (live) {
      if (options.startupPreference() !== "server") {
        await reconnectOfflineGptServer();
      }
      return live;
    }

    try {
      hostInfo = await offlinegptServerRestart({
        remoteAccessEnabled: state.offlinegptServerSettings.remoteAccessEnabled === true,
      }) as OfflineGptServerInfo;
      mutateState((current) => ({ ...current, offlinegptServerHostInfo: hostInfo }));
    } catch {
      return null;
    }

    const baseUrl = hostInfo?.baseUrl?.trim() ?? "";
    const token = hostInfo?.clientToken?.trim() ?? "";
    const hostToken = hostInfo?.hostToken?.trim() ?? "";
    if (!baseUrl || !token) return null;

    if (options.startupPreference() !== "server") {
      await reconnectOfflineGptServer();
    }

    return createOfflineGptServerClient({
      baseUrl,
      token,
      hostToken: hostToken || undefined,
    });
  }

  const saveShareRemoteAccess = async (enabled: boolean) => {
    if (state.shareRemoteAccessBusy) return;
    const previous = state.offlinegptServerSettings;
    const next: OfflineGptServerSettings = {
      ...previous,
      remoteAccessEnabled: enabled,
    };

    mutateState((current) => ({
      ...current,
      shareRemoteAccessBusy: true,
      shareRemoteAccessError: null,
    }));
    updateOfflineGptServerSettings(next);

    try {
      if (isDesktopRuntime() && options.selectedWorkspaceDisplay().workspaceType === "local") {
        const restarted = await options.restartLocalServer();
        if (!restarted) {
          throw new Error(t("app.error_restart_local_worker"));
        }
        await reconnectOfflineGptServer();
      }
    } catch (error) {
      updateOfflineGptServerSettings(previous);
      mutateState((current) => ({
        ...current,
        shareRemoteAccessError:
          error instanceof Error
            ? error.message
            : t("app.error_remote_access"),
      }));
      return;
    } finally {
      setStateField("shareRemoteAccessBusy", false);
    }
  };

  refreshSnapshot();

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const getSnapshot = () => {
    if (!snapshot) throw new Error("OfflineGPT server snapshot was not initialized.");
    return snapshot;
  };

  return {
    subscribe,
    getSnapshot,
    start,
    dispose,
    syncFromOptions,
    setOfflineGptServerSettings,
    updateOfflineGptServerSettings,
    resetOfflineGptServerSettings,
    saveShareRemoteAccess,
    checkOfflineGptServer,
    testOfflineGptServerConnection,
    reconnectOfflineGptServer,
    ensureLocalOfflineGptServerClient,
  };
}

export function useOfflineGptServerStoreSnapshot(store: OfflineGptServerStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
