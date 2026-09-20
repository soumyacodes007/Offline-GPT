declare const afterEach: (fn: () => void | Promise<void>) => void;
declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
};

import { DEFAULT_DEN_BASE_URL, HOSTED_DEFAULT_DEN_BASE_URL, setDenBootstrapConfig } from "../../../app/lib/den";
import {
  hasOfflineGPTModelsAvailable,
  isOfflineGPTModelsPromoEligible,
  isOfflineGPTModelsPromoEligibleForDenBaseUrl,
  shouldShowOfflineGPTModelsPromo,
  shouldShowOfflineGPTModelsSyncing,
  wasOfflineGPTModelsStartupPromoShown,
} from "./offlinegpt-models-promo";

afterEach(async () => {
  await setDenBootstrapConfig({ baseUrl: DEFAULT_DEN_BASE_URL, requireSignin: false });
});

describe("OfflineGPT Models promo eligibility", () => {
  test("allows promotions on the default Den URL after normalization", () => {
    expect(isOfflineGPTModelsPromoEligibleForDenBaseUrl(`${HOSTED_DEFAULT_DEN_BASE_URL}/api/den/`)).toBe(true);
  });

  test("suppresses promotions for custom configured Den URLs", async () => {
    await setDenBootstrapConfig({ baseUrl: "https://custom-den.example.com", requireSignin: false });

    expect(isOfflineGPTModelsPromoEligible()).toBe(false);
    expect(shouldShowOfflineGPTModelsPromo()).toBe(false);
    expect(wasOfflineGPTModelsStartupPromoShown()).toBe(true);
  });
});

describe("hasOfflineGPTModelsAvailable", () => {
  test("requires a connected offlinegpt provider with at least one model", () => {
    expect(
      hasOfflineGPTModelsAvailable({
        providerConnectedIds: ["offlinegpt"],
        providers: [{ id: "offlinegpt", models: {} }],
      }),
    ).toBe(false);
    expect(
      hasOfflineGPTModelsAvailable({
        providerConnectedIds: ["offlinegpt"],
        providers: [{ id: "offlinegpt", models: { "gpt-5": {} } }],
      }),
    ).toBe(true);
  });
});

describe("shouldShowOfflineGPTModelsSyncing", () => {
  test("only reports a real pending workspace reload", () => {
    expect(shouldShowOfflineGPTModelsSyncing({
      entitled: true,
      available: false,
      workspaceReady: false,
      reloadPending: true,
    })).toBe(false);
    expect(shouldShowOfflineGPTModelsSyncing({
      entitled: true,
      available: false,
      workspaceReady: true,
      reloadPending: false,
    })).toBe(false);
    expect(shouldShowOfflineGPTModelsSyncing({
      entitled: true,
      available: false,
      workspaceReady: true,
      reloadPending: true,
    })).toBe(true);
  });
});
