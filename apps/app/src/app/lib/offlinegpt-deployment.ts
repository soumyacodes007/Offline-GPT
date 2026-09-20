export const OFFLINEGPT_DEPLOYMENT_ENV_VAR = "VITE_OFFLINEGPT_DEPLOYMENT";

export type OfflineGPTDeployment = "desktop" | "web";

function normalizeDeployment(value: string | undefined): OfflineGPTDeployment {
  const normalized = value?.trim().toLowerCase();
  return normalized === "web" ? "web" : "desktop";
}

export function getOfflineGPTDeployment(): OfflineGPTDeployment {
  const envValue =
    typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_OFFLINEGPT_DEPLOYMENT === "string"
      ? import.meta.env.VITE_OFFLINEGPT_DEPLOYMENT
      : undefined;

  return normalizeDeployment(envValue);
}

export function isWebDeployment(): boolean {
  return getOfflineGPTDeployment() === "web";
}

export function isDesktopDeployment(): boolean {
  return getOfflineGPTDeployment() === "desktop";
}
