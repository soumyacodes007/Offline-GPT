// Gateway runtime detection primitives. Leaf module by design: keep it import-free
// so low-level clients can choose same-origin gateway behavior without cycles.
export type OfflineGptGatewayMarker = {
  version?: number;
  build?: string;
};

declare global {
  interface Window {
    __OFFLINEGPT_GATEWAY__?: OfflineGptGatewayMarker;
  }
}

const DEN_AUTH_TOKEN_STORAGE_KEY = "offlinegpt.den.authToken";

export function isOfflineGptGatewayRuntime() {
  return typeof window !== "undefined" && window.__OFFLINEGPT_GATEWAY__?.version === 1;
}

export function getOfflineGptGatewayBuild(): string | null {
  if (!isOfflineGptGatewayRuntime()) return null;
  const build = window.__OFFLINEGPT_GATEWAY__?.build?.trim() ?? "";
  return build || null;
}

export function getOfflineGptGatewayOrigin() {
  if (!isOfflineGptGatewayRuntime()) return null;
  const origin = window.location.origin.trim();
  return origin || null;
}

export function readOfflineGptGatewayDenToken() {
  if (!isOfflineGptGatewayRuntime()) return "";
  try {
    return window.localStorage.getItem(DEN_AUTH_TOKEN_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}
