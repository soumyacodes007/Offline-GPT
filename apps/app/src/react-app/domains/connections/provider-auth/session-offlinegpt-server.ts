// Session-route adapter for the provider-auth store's `offlinegptServer` slice.
//
// The settings route feeds the store the full offlinegpt-server store, whose
// snapshot carries the server's real capabilities (including `providerSync`)
// and host-token auth. The session route used to fabricate a snapshot with
// hard-coded `{ config }` capabilities and no auth at all, so on the app's
// default surface `serverHandlesProviderSync()` was permanently false:
// PUT /den-session never fired after sign-in, the local server never learned
// the Den session, and server-side cloud provider sync never started (#3671).
//
// This adapter reports the truth for the endpoint it wraps:
// - local endpoints (the desktop's own OfflineGPT server) advertise
//   `providerSync: true` — every OfflineGPT server does
//   (apps/server/src/types.ts `Capabilities.providerSync: true`) — and carry
//   the live host token so the store can PUT /den-session and
//   POST /cloud-provider-sync/run;
// - remote workspaces keep the previous conservative shape (config only): a
//   desktop must not push its Den session to a shared remote worker.
import {
  createOfflineGptServerClient,
  isLoopbackOfflineGptServerUrl,
  readOfflineGptServerSettings,
  type OfflineGptServerClient,
} from "@/app/lib/offlinegpt-server";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { ProviderAuthOfflineGptServer } from "./store";

type SessionOfflineGptServerSnapshot = ReturnType<ProviderAuthOfflineGptServer["getSnapshot"]>;

export type CreateSessionOfflineGptServerInput = {
  endpoint: () => ResolvedWorkspaceEndpoint | null;
  /** Live host token from the desktop runtime (offlinegptServerInfo). */
  hostToken?: () => string;
};

function resolveHostToken(endpoint: ResolvedWorkspaceEndpoint, live: string): string {
  if (live) return live;
  // Fallback mirrors offlinegpt-server-store's getAuth(): persisted settings may
  // hold the host token (ensureDesktopLocalOfflineGptConnection writes it), but
  // only trust it for loopback servers — host tokens never travel off-machine.
  if (!isLoopbackOfflineGptServerUrl(endpoint.baseUrl)) return "";
  return readOfflineGptServerSettings().hostToken?.trim() ?? "";
}

export function createSessionOfflineGptServer(
  input: CreateSessionOfflineGptServerInput,
): ProviderAuthOfflineGptServer {
  let clientCacheKey = "";
  let clientCacheValue: OfflineGptServerClient | null = null;

  const hostAwareClient = (endpoint: ResolvedWorkspaceEndpoint, hostToken: string): OfflineGptServerClient => {
    if (!hostToken) return endpoint.client;
    const key = `${endpoint.baseUrl}\u001f${endpoint.token}\u001f${hostToken}`;
    if (key !== clientCacheKey || !clientCacheValue) {
      clientCacheKey = key;
      clientCacheValue = createOfflineGptServerClient({
        baseUrl: endpoint.baseUrl,
        token: endpoint.token || undefined,
        hostToken,
      });
    }
    return clientCacheValue;
  };

  return {
    getSnapshot: (): SessionOfflineGptServerSnapshot => {
      const endpoint = input.endpoint();
      if (!endpoint) {
        return {
          offlinegptServerStatus: "disconnected",
          offlinegptServerClient: null,
          offlinegptServerCapabilities: null,
        };
      }
      if (endpoint.isRemote) {
        return {
          offlinegptServerStatus: "connected",
          offlinegptServerClient: endpoint.client,
          offlinegptServerCapabilities: { config: { read: true, write: true } },
        };
      }
      const hostToken = resolveHostToken(endpoint, input.hostToken?.().trim() ?? "");
      return {
        offlinegptServerStatus: "connected",
        offlinegptServerClient: hostAwareClient(endpoint, hostToken),
        offlinegptServerAuth: {
          token: endpoint.token || undefined,
          hostToken: hostToken || undefined,
        },
        offlinegptServerCapabilities: {
          config: { read: true, write: true },
          providerSync: true,
        },
      };
    },
  };
}
