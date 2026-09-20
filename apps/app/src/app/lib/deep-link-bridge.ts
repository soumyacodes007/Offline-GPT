export const deepLinkBridgeEvent = "offlinegpt:deep-link";
export const nativeDeepLinkEvent = "offlinegpt:deep-link-native";

export type DeepLinkBridgeDetail = {
  urls: string[];
};

declare global {
  interface Window {
    __OFFLINEGPT__?: {
      deepLinks?: string[];
    };
  }
}

function normalizeDeepLinks(urls: readonly string[]): string[] {
  return urls.flatMap((url) => {
    const trimmed = url.trim();
    return trimmed ? [trimmed] : [];
  });
}

export function pushPendingDeepLinks(target: Window, urls: readonly string[]): string[] {
  const normalized = normalizeDeepLinks(urls);
  if (normalized.length === 0) {
    return [];
  }

  target.__OFFLINEGPT__ ??= {};
  const pending = target.__OFFLINEGPT__.deepLinks ?? [];
  target.__OFFLINEGPT__.deepLinks = [...pending, ...normalized];
  target.dispatchEvent(
    new CustomEvent<DeepLinkBridgeDetail>(deepLinkBridgeEvent, {
      detail: { urls: normalized },
    }),
  );
  return normalized;
}

export function drainPendingDeepLinks(target: Window): string[] {
  const pending = target.__OFFLINEGPT__?.deepLinks ?? [];
  if (target.__OFFLINEGPT__) {
    target.__OFFLINEGPT__.deepLinks = [];
  }
  return [...pending];
}
