import { afterEach, describe, expect, test } from "bun:test";

import { MCP_QUICK_CONNECT } from "../src/app/constants";
import { createOfflineGptServerClient } from "../src/app/lib/offlinegpt-server";
import { createOfflineGptServerStore } from "../src/react-app/domains/connections/offlinegpt-server-store";
import type { McpDirectoryInfo } from "../src/app/constants";
import { submitMcpEntry } from "../src/react-app/domains/connections/modals/add-mcp-submission";
import type { OfflineGptServerStore } from "../src/react-app/domains/connections/offlinegpt-server-store";
import { createConnectionsStore } from "../src/react-app/domains/connections/store";

const originalWindow = globalThis.window;

function installDesktopWindow() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __OFFLINEGPT_ELECTRON__: {} },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("local MCP server recovery", () => {
  test("returns submission feedback when local server recovery never settles", async () => {
    installDesktopWindow();
    let recoveryAttempts = 0;
    const stalledRecovery = new Promise<never>(() => undefined);
    const offlinegptServer = {
      getSnapshot: () => ({
        offlinegptServerStatus: "disconnected",
        offlinegptServerClient: null,
        offlinegptServerCapabilities: null,
      }),
      ensureLocalOfflineGptServerClient: () => {
        recoveryAttempts += 1;
        return stalledRecovery;
      },
    } as unknown as OfflineGptServerStore;
    const store = createConnectionsStore({
      checkDesktopAppRestriction: () => false,
      client: () => null,
      setClient: () => undefined,
      projectDir: () => "/tmp/offlinegpt-mcp-recovery",
      selectedWorkspaceId: () => "workspace_local",
      selectedWorkspaceRoot: () => "/tmp/offlinegpt-mcp-recovery",
      workspaceType: () => "local",
      offlinegptServer,
      runtimeWorkspaceId: () => null,
      ensureRuntimeWorkspaceId: async () => "workspace_local",
      localOfflineGptServerRecoveryTimeoutMs: 10,
      developerMode: () => false,
    });
    const entry: McpDirectoryInfo = {
      name: "Stalled recovery",
      description: "",
      type: "remote",
      url: "https://example.com/mcp",
      oauth: true,
      managedOAuth: true,
    };

    const result = await Promise.race([
      submitMcpEntry(store.connectMcp, entry, "Fallback error"),
      new Promise<"still pending">((resolve) => setTimeout(() => resolve("still pending"), 250)),
    ]);

    expect(recoveryAttempts).toBe(1);
    expect(result).not.toBe("still pending");
    expect(result).not.toBeNull();
    expect(store.getSnapshot().mcpConnectingName).toBeNull();
  });
});

describe("Computer Use (Cua Driver) setup", () => {
  async function connectWithHelper(command: string[] | null) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __OFFLINEGPT_ELECTRON__: { invokeDesktop: async (name: string) => name === "getCuaDriverMcpCommand" ? command : null } },
    });
    const server = createOfflineGptServerStore({
      startupPreference: () => "server", documentVisible: () => true, developerMode: () => false,
      runtimeWorkspaceId: () => "setup-workspace", activeClient: () => null,
      selectedWorkspaceDisplay: () => ({ id: "setup-workspace", name: "Setup", path: "/tmp/setup", preset: "starter", workspaceType: "local" }),
      restartLocalServer: async () => false, createRemoteWorkspaceFlow: async () => false,
    });
    const saved: Array<Parameters<ReturnType<typeof createOfflineGptServerClient>["addMcp"]>[1]> = [];
    const skills: Array<Parameters<ReturnType<typeof createOfflineGptServerClient>["upsertSkill"]>[1]> = [];
    const client = {
      ...createOfflineGptServerClient({ baseUrl: "http://127.0.0.1:1" }),
      addMcp: async (_workspace: string, payload: Parameters<ReturnType<typeof createOfflineGptServerClient>["addMcp"]>[1]) => { saved.push(payload); return { items: [] }; },
      upsertSkill: async (_workspace: string, payload: Parameters<ReturnType<typeof createOfflineGptServerClient>["upsertSkill"]>[1]) => {
        skills.push(payload);
        return { name: payload.name, path: `/tmp/setup/.opencode/skills/${payload.name}/SKILL.md`, description: "", scope: "project" as const };
      },
      listMcp: async () => ({ items: [] }),
    };
    const getSnapshot: typeof server.getSnapshot = () => ({ ...server.getSnapshot(), offlinegptServerStatus: "connected", offlinegptServerClient: client });
    const store = createConnectionsStore({
      checkDesktopAppRestriction: () => false, client: () => null, setClient: () => {},
      projectDir: () => "/tmp/setup", selectedWorkspaceId: () => "setup-workspace", selectedWorkspaceRoot: () => "/tmp/setup",
      workspaceType: () => "local", offlinegptServer: { ...server, getSnapshot }, runtimeWorkspaceId: () => "setup-workspace", developerMode: () => false,
    });
    const entry = MCP_QUICK_CONNECT.find((entry) => entry.id === "computer-use");
    if (!entry) throw new Error("Computer Use catalog entry missing");
    expect(entry.command).toEqual([]);
    const result = await store.connectMcp(entry);
    return { result, saved, skills };
  }

  test("resolves the installed cua-driver and installs the cua-driver skill pack", async () => {
    const command = ["/Users/person/.local/bin/cua-driver", "mcp"];
    const { result, saved, skills } = await connectWithHelper(command);
    expect(result).toEqual({ ok: true });
    expect(saved).toEqual([{ name: "computer-use", config: { type: "local", enabled: true, command } }]);
    expect(skills.map((skill) => skill.name)).toEqual(["cua-driver"]);
    expect(skills[0]?.content).toContain("name: cua-driver");
    expect(skills[0]?.files?.map((file) => file.path)).toEqual(expect.arrayContaining(["WORKFLOW.md", "RUNTIME.md", "MACOS.md", "WINDOWS.md", "LINUX.md", "LICENSE.md"]));
  });

  test("missing Cua Driver returns an actionable error without saving a connection", async () => {
    const { result, saved, skills } = await connectWithHelper(null);
    expect(result).toEqual({ ok: false, error: "Computer Use requires Cua Driver. Install it from Library → Computer Use." });
    expect(saved).toEqual([]);
    expect(skills).toEqual([]);
  });
});
