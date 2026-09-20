import { INFERENCE_MODEL_ALIASES } from "@offlinegpt/types/den/inference";

import {
  buildDenAuthUrl,
  getDenInferenceUrl,
  isSelfHostedControlPlane,
  HOSTED_DEFAULT_DEN_BASE_URL,
  readDenBootstrapConfig,
  readDenSettings,
} from "../../../app/lib/den";
import { isDefaultControlPlaneUrl } from "../settings/cloud/control-plane-url";
import { denSettingsChangedEvent } from "../../../app/lib/den-session-events";
import { useSyncExternalStore } from "react";

export const OFFLINEGPT_MODELS_PROVIDER_ID = "offlinegpt";
export const OFFLINEGPT_MODELS_PROVIDER_NAME = "OfflineGPT Models";
export const OFFLINEGPT_MODELS_PROMO_HIDDEN_KEY = "offlinegpt.offlinegptModelsPromo.hidden";
export const OFFLINEGPT_MODELS_PROMO_LAST_SHOWN_KEY = "offlinegpt.offlinegptModelsPromo.lastShownAt";
export const OFFLINEGPT_MODELS_STARTUP_PROMO_SHOWN_KEY = "offlinegpt.offlinegptModelsPromo.startupShown";
export const offlineGptModelsPromoChangedEvent = "offlinegpt-offlinegpt-models-promo-changed";
export const OFFLINEGPT_MODELS_PROMO_SHOW_DELAY_MS = 4_000;
export const OFFLINEGPT_MODELS_PROMO_VISIBLE_MS = 14_000;
export const OFFLINEGPT_MODELS_PROMO_REPEAT_MS = 6 * 60 * 60 * 1000;

export function areOfflineGPTModelsPromosDisabled() {
  if (/^(1|true|yes|on)$/i.test(String(import.meta.env.VITE_DISABLE_OFFLINEGPT_MODELS ?? "").trim())) {
    return true;
  }
  // OfflineGPT Models are a hosted OfflineGPT Cloud offering; self-hosted
  // deployments should never see the upsell surfaces.
  return isSelfHostedControlPlane();
}

export function isOfflineGPTModelsPromoEligibleForDenBaseUrl(baseUrl: string) {
  return !areOfflineGPTModelsPromosDisabled() && isDefaultControlPlaneUrl(baseUrl, HOSTED_DEFAULT_DEN_BASE_URL);
}

export function isOfflineGPTModelsPromoEligible() {
  return isOfflineGPTModelsPromoEligibleForDenBaseUrl(readDenSettings().baseUrl);
}

export function useOfflineGPTModelsPromoEligibility() {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window === "undefined") return () => undefined;
      window.addEventListener(denSettingsChangedEvent, notify);
      return () => window.removeEventListener(denSettingsChangedEvent, notify);
    },
    isOfflineGPTModelsPromoEligible,
    isOfflineGPTModelsPromoEligible,
  );
}

export type OfflineGPTModelPreview = {
  id: string;
  title: string;
  subtitle: string;
};

export const OFFLINEGPT_MODEL_PREVIEWS: OfflineGPTModelPreview[] = Object.entries(
  INFERENCE_MODEL_ALIASES,
)
  .filter(([, model]) => model.enabled)
  .map(([id, model]) => ({
    id,
    title: model.displayName.replace(/^OfflineGPT:\s*/, ""),
    subtitle: "OfflineGPT hosted",
  }));

export function hasOfflineGPTModelsProvider(providerIds: readonly string[]) {
  return providerIds.some((id) => id.trim().toLowerCase() === OFFLINEGPT_MODELS_PROVIDER_ID);
}

/** Local engine has OfflineGPT Models connected with at least one selectable model. */
export function hasOfflineGPTModelsAvailable(input: {
  providerConnectedIds: readonly string[];
  providers: ReadonlyArray<{ id: string; models?: Record<string, unknown> | null }>;
}) {
  if (!hasOfflineGPTModelsProvider(input.providerConnectedIds)) return false;
  const offlinegpt = input.providers.find(
    (provider) => provider.id.trim().toLowerCase() === OFFLINEGPT_MODELS_PROVIDER_ID,
  );
  return Object.keys(offlinegpt?.models ?? {}).length > 0;
}

export function shouldShowOfflineGPTModelsSyncing(input: {
  entitled: boolean;
  available: boolean;
  workspaceReady: boolean;
  reloadPending: boolean;
}) {
  return input.entitled && !input.available && input.workspaceReady && input.reloadPending;
}

export function getOfflineGPTModelsActionUrl(
  isSignedIn: boolean,
  authMode: "sign-in" | "sign-up" = "sign-in",
) {
  const settings = readDenSettings();
  const baseUrl = settings.baseUrl || readDenBootstrapConfig().baseUrl;
  // Signed-in users go straight to the OfflineGPT Models page — the value-prop
  // + subscribe surface — never to a bare auth or billing page.
  return isSignedIn ? getDenInferenceUrl(baseUrl) : buildDenAuthUrl(baseUrl, authMode);
}

export function isOfflineGPTModelsPromoHidden() {
  if (areOfflineGPTModelsPromosDisabled()) return true;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(OFFLINEGPT_MODELS_PROMO_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function hideOfflineGPTModelsPromo() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(OFFLINEGPT_MODELS_PROMO_HIDDEN_KEY, "1");
    window.dispatchEvent(new Event(offlineGptModelsPromoChangedEvent));
  } catch {}
}

export function wasOfflineGPTModelsStartupPromoShown() {
  if (!isOfflineGPTModelsPromoEligible()) return true;
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(OFFLINEGPT_MODELS_STARTUP_PROMO_SHOWN_KEY) === "1";
  } catch {
    return true;
  }
}

export function markOfflineGPTModelsStartupPromoShown() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(OFFLINEGPT_MODELS_STARTUP_PROMO_SHOWN_KEY, "1");
  } catch {}
}

export function shouldShowOfflineGPTModelsPromo(now = Date.now()) {
  if (!isOfflineGPTModelsPromoEligible() || typeof window === "undefined" || isOfflineGPTModelsPromoHidden()) return false;
  try {
    const lastShown = Number(window.localStorage.getItem(OFFLINEGPT_MODELS_PROMO_LAST_SHOWN_KEY) ?? "0");
    return !Number.isFinite(lastShown) || now - lastShown >= OFFLINEGPT_MODELS_PROMO_REPEAT_MS;
  } catch {
    return true;
  }
}

export function markOfflineGPTModelsPromoShown(now = Date.now()) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(OFFLINEGPT_MODELS_PROMO_LAST_SHOWN_KEY, String(now));
  } catch {}
}
