import { describe, expect, test } from "bun:test";

import {
  offlineGptConnectAttentionTitle,
  resolveOfflineGPTConnectStateSummary,
  resolveOfflineGPTConnectStatus,
} from "../src/react-app/domains/connections/offlinegpt-connect-status";
import type { SessionCloudMcpMaintenanceState } from "../src/react-app/domains/connections/use-session-mcp-maintenance";

function maintenance(
  status: SessionCloudMcpMaintenanceState["status"],
): SessionCloudMcpMaintenanceState {
  return {
    status,
    issue: status === "failed"
      ? {
          code: "cloud_mcp_unavailable",
          stage: "engine_delivery",
          retryable: false,
          recommendedAction: "Run diagnostics",
          message: "Connected service tools could not be verified.",
        }
      : null,
    attempt: status === "retrying" ? 2 : 1,
    maxAttempts: 3,
  };
}

describe("OfflineGPT Connect status", () => {
  test("distinguishes missing, disabled, and unreadable Connect state", () => {
    expect(resolveOfflineGPTConnectStateSummary("missing", false)).toEqual({
      status: "not_configured",
      statusLabel: "Not configured",
      tone: "neutral",
      stageLabel: "Connect setup is not finished",
      recommendedAction: "Sign in to OfflineGPT Cloud to finish setup.",
    });
    expect(resolveOfflineGPTConnectStateSummary("available", false)).toEqual({
      status: "disabled",
      statusLabel: "Disabled",
      tone: "neutral",
      stageLabel: "Disabled by organization policy",
      recommendedAction: "Ask an organization admin to enable Connect.",
    });
    for (const status of ["invalid", "unreadable"] satisfies Array<"invalid" | "unreadable">) {
      expect(resolveOfflineGPTConnectStateSummary(status, false)).toEqual({
        status: "unavailable",
        statusLabel: "Needs attention",
        tone: "error",
        stageLabel: "Connect settings are unavailable",
        recommendedAction: "Restart OfflineGPT. If this continues, run diagnostics.",
      });
    }
  });

  test("labels the diagnosed message as one possible issue for native tooltips", () => {
    expect(offlineGptConnectAttentionTitle("Connected service tools could not be verified."))
      .toBe("One possible issue: Connected service tools could not be verified.");
  });

  test("is hidden while signed out", () => {
    expect(resolveOfflineGPTConnectStatus(false, maintenance("ready"))).toBeNull();
  });

  test("shows the verified Cloud connection while workspace maintenance is idle", () => {
    expect(resolveOfflineGPTConnectStatus(true, undefined)).toEqual({
      state: "ready",
      label: "Ready",
      description: "Signed in to OfflineGPT Cloud. Connected service tools will be checked when a workspace is active.",
    });
    expect(resolveOfflineGPTConnectStatus(true, maintenance("idle"))).toMatchObject({
      state: "ready",
      label: "Ready",
    });
  });

  test("maps the active lifecycle to checking, ready, and needs attention", () => {
    expect(resolveOfflineGPTConnectStatus(true, maintenance("checking"))).toMatchObject({
      state: "checking",
      label: "Checking",
    });
    expect(resolveOfflineGPTConnectStatus(true, maintenance("retrying"))).toMatchObject({
      state: "checking",
      description: "Restoring connected service tools (2/3).",
    });
    expect(resolveOfflineGPTConnectStatus(true, maintenance("ready"))).toMatchObject({
      state: "ready",
      label: "Ready",
    });
    expect(resolveOfflineGPTConnectStatus(true, maintenance("failed"))).toEqual({
      state: "needs_attention",
      label: "Needs attention",
      description: "Connected service tools could not be verified.",
    });
    expect(resolveOfflineGPTConnectStatus(true, maintenance("skipped"))).toMatchObject({
      state: "needs_attention",
      label: "Needs attention",
    });
  });
});
