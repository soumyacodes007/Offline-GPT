import type { DenOfflineGPTWebAccessSource } from "../../../app/lib/den";

export type OfflineGPTWebAccessCheck = {
  scope: string;
  state: "granted" | "denied" | "error";
  accessSource: DenOfflineGPTWebAccessSource;
};

export type OfflineGPTWebAccessGateState = "inactive" | "checking" | "granted" | "denied" | "error";

export function resolveOfflineGPTWebAccessGateState(input: {
  gatewayMode: boolean;
  authStatus: "checking" | "signed_in" | "unavailable" | "signed_out";
  authToken: string;
  organizationId: string;
  verifiedIdentity: { principalId: string; organizationId: string } | null;
  expectedScope: string | null;
  check: OfflineGPTWebAccessCheck | null;
}): OfflineGPTWebAccessGateState {
  if (!input.gatewayMode || !input.authToken || !input.organizationId) return "inactive";
  if (input.authStatus === "unavailable") return "error";
  if (input.authStatus !== "signed_in") return "checking";
  if (
    !input.verifiedIdentity
    || input.verifiedIdentity.organizationId !== input.organizationId
    || !input.expectedScope
  ) {
    return "checking";
  }
  if (!input.check || input.check.scope !== input.expectedScope) return "checking";
  return input.check.state;
}
