import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  composeOfflineGPTExtensionDiscoveryInstruction,
  composeSkillAuthoringInstruction,
  composeSteeringFromEngineMcpStatus,
  OFFLINEGPT_CLOUD_CONNECTION_INSTRUCTION,
  OFFLINEGPT_CLOUD_SKILL_AUTHORING_INSTRUCTION,
  OFFLINEGPT_CONNECT_DISABLED_INSTRUCTION,
  OFFLINEGPT_CONNECT_SIGN_IN_INSTRUCTION,
  OFFLINEGPT_EXTENSION_DISCOVERY_INSTRUCTION,
  OFFLINEGPT_LOCAL_SKILL_AUTHORING_INSTRUCTION,
  resetOfflineGPTExtensionDiscoveryInstructionCacheForTests,
  resolveOfflineGPTExtensionDiscoveryInstruction,
  type OfflineGPTEngineMcpStatusClient,
  type OfflineGPTExtensionConnectState,
} from "./offlinegpt-extensions-preview-steering.js";

type CloudHealth = NonNullable<OfflineGPTExtensionConnectState["cloudHealth"]>;
type CloudFailure = NonNullable<CloudHealth["firstFailure"]>;

const originalServerUrl = process.env.OFFLINEGPT_SERVER_URL;
const originalServerToken = process.env.OFFLINEGPT_SERVER_TOKEN;

const UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION =
  "If the user asks for something you cannot do with obvious built-in tools, check OfflineGPT extensions before saying the capability is unavailable. Use offlinegpt_query with id extension.actions to inspect available extension actions, then offlinegpt_execute with id extension.call for the matching action.";

beforeEach(() => {
  resetOfflineGPTExtensionDiscoveryInstructionCacheForTests();
});

afterEach(() => {
  resetOfflineGPTExtensionDiscoveryInstructionCacheForTests();
  if (originalServerUrl === undefined) delete process.env.OFFLINEGPT_SERVER_URL;
  else process.env.OFFLINEGPT_SERVER_URL = originalServerUrl;
  if (originalServerToken === undefined) delete process.env.OFFLINEGPT_SERVER_TOKEN;
  else process.env.OFFLINEGPT_SERVER_TOKEN = originalServerToken;
});

function health(overrides: Partial<NonNullable<OfflineGPTExtensionConnectState["cloudHealth"]>> = {}): NonNullable<OfflineGPTExtensionConnectState["cloudHealth"]> {
  return {
    usable: true,
    usableByCurrentModel: true,
    phase: "ready",
    workspace: { id: "ws_1", directory: "/tmp/ws_1" },
    desired: { present: true, revision: "rev_ready" },
    firstFailure: null,
    ...overrides,
  };
}

function failure(code: string, overrides: Partial<CloudFailure> = {}): CloudFailure {
  return {
    code,
    stage: overrides.stage ?? "test",
    recommendedAction: overrides.recommendedAction ?? "Check Settings → Connect.",
    message: overrides.message ?? "test failure",
  };
}

function expectNoDegradedSteering(instruction: string): void {
  expect(instruction).not.toMatch(/not ready/i);
  expect(instruction).not.toContain("Repair and test");
  expect(instruction).not.toContain("Do not use OfflineGPT documentation tools");
  expect(instruction).not.toContain("Do not substitute docs");
  expect(instruction).not.toContain("as a substitute for performing an action against a connected service");
  expect(instruction).not.toMatch(/do NOT use/i);
  expect(instruction).not.toMatch(/Do not try/);
}

function state(cloudHealth: OfflineGPTExtensionConnectState["cloudHealth"]): OfflineGPTExtensionConnectState {
  return {
    connectEnabled: true,
    connectCatalogEnabled: true,
    cloudMcpPresent: cloudHealth?.usable === true,
    cloudHealth,
    workspace: { resolution: "resolved", id: "ws_1", directory: "/tmp/ws_1" },
    googleWorkspace: { legacyConfigured: false },
  };
}

function engineMcpClient(result: unknown, requests: unknown[] = []): OfflineGPTEngineMcpStatusClient {
  return {
    mcp: {
      status: async (request) => {
        requests.push(request);
        return result;
      },
    },
  };
}

describe("composeSteeringFromEngineMcpStatus", () => {
  test("maps engine MCP statuses to steering instructions", () => {
    expect(composeSteeringFromEngineMcpStatus("connected")).toBe(OFFLINEGPT_CLOUD_CONNECTION_INSTRUCTION);
    expect(composeSteeringFromEngineMcpStatus("disabled")).toBe(OFFLINEGPT_CONNECT_DISABLED_INSTRUCTION);
    expect(composeSteeringFromEngineMcpStatus("needs_auth")).toBe(OFFLINEGPT_CONNECT_SIGN_IN_INSTRUCTION);
    expect(composeSteeringFromEngineMcpStatus("needs_client_registration")).toBe(OFFLINEGPT_CONNECT_SIGN_IN_INSTRUCTION);
    expect(composeSteeringFromEngineMcpStatus("failed")).toBe(OFFLINEGPT_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(composeSteeringFromEngineMcpStatus("starting")).toBe(OFFLINEGPT_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(composeSteeringFromEngineMcpStatus(undefined)).toBe(OFFLINEGPT_EXTENSION_DISCOVERY_INSTRUCTION);
  });
});

describe("composeOfflineGPTExtensionDiscoveryInstruction", () => {
  test("keeps the fallback instruction byte-identical when state is unavailable or generic discovery is gated", () => {
    expect(OFFLINEGPT_EXTENSION_DISCOVERY_INSTRUCTION).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(composeOfflineGPTExtensionDiscoveryInstruction(null)).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(composeOfflineGPTExtensionDiscoveryInstruction({ ...state(null), connectCatalogEnabled: false })).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
  });

  test("keeps fallback when only legacy Google Workspace is configured", () => {
    expect(composeOfflineGPTExtensionDiscoveryInstruction({ ...state(null), googleWorkspace: { legacyConfigured: true } })).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
  });

  test("steers ready Connect users to verified offlinegpt-cloud capabilities first", () => {
    expect(OFFLINEGPT_CLOUD_CONNECTION_INSTRUCTION).toContain("verified ready for this exact workspace/model");
    // Tool mechanics and the "only name what search returns" rule live once in
    // the base agent prompt; ready steering is the availability signal only.
    expect(OFFLINEGPT_CLOUD_CONNECTION_INSTRUCTION).not.toContain("offlinegpt-cloud_search_capabilities with");
    expect(OFFLINEGPT_CLOUD_CONNECTION_INSTRUCTION).not.toContain("available_skills");
    expect(OFFLINEGPT_CLOUD_CONNECTION_INSTRUCTION).not.toContain("A successful search proves");
    expect(OFFLINEGPT_CLOUD_CONNECTION_INSTRUCTION).not.toContain("Skill creation:");
    expect(OFFLINEGPT_CLOUD_CONNECTION_INSTRUCTION).not.toContain("Gmail");
    expect(OFFLINEGPT_CLOUD_CONNECTION_INSTRUCTION).not.toContain("image generation");
    // The detailed Connect contract ships as the offlinegpt-cloud server's MCP
    // initialize instructions, present exactly when this steering is chosen.
    // Ready steering defers to it instead of restating it on every request.
    expect(OFFLINEGPT_CLOUD_CONNECTION_INSTRUCTION).toContain("server instructions in this prompt are authoritative for search-first discovery, MCP Apps, connection_status results, schema guidance, and retry rules");
    expect(OFFLINEGPT_CLOUD_CONNECTION_INSTRUCTION).not.toContain("relay connectionStatus.action exactly");
    expect(OFFLINEGPT_CLOUD_CONNECTION_INSTRUCTION).not.toContain("results are live, not cached");
    expect(OFFLINEGPT_CLOUD_CONNECTION_INSTRUCTION.length).toBeLessThan(600);
    expect(composeOfflineGPTExtensionDiscoveryInstruction(state(health()))).toBe(OFFLINEGPT_CLOUD_CONNECTION_INSTRUCTION);
    expect(composeOfflineGPTExtensionDiscoveryInstruction({ ...state(health()), connectCatalogEnabled: false })).toBe(OFFLINEGPT_CLOUD_CONNECTION_INSTRUCTION);
    expect(composeOfflineGPTExtensionDiscoveryInstruction({ ...state(health()), googleWorkspace: { legacyConfigured: true } })).toBe(OFFLINEGPT_CLOUD_CONNECTION_INSTRUCTION);
  });

  test("selects one compact skill-authoring prompt from verified Cloud access", () => {
    expect(composeSkillAuthoringInstruction(OFFLINEGPT_CLOUD_CONNECTION_INSTRUCTION)).toEqual({
      mode: "cloud",
      prompt: OFFLINEGPT_CLOUD_SKILL_AUTHORING_INSTRUCTION,
    });
    expect(OFFLINEGPT_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("Skill creation: Cloud");
    expect(OFFLINEGPT_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("retrieve and follow the listed create-skill remote skill");
    expect(OFFLINEGPT_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("offlinegpt-cloud_execute_capability");
    expect(OFFLINEGPT_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("exact <capability>");
    expect(OFFLINEGPT_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("OfflineGPT Cloud as a private plugin");
    expect(OFFLINEGPT_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("use share-plugin when the user wants a specific person or team to use a skill");
    expect(OFFLINEGPT_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("add-to-marketplace");
    expect(OFFLINEGPT_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("add-user-to-marketplace");
    expect(OFFLINEGPT_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("workspace-local skill");
    expect(OFFLINEGPT_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("Do not create both copies");
    expect(OFFLINEGPT_CLOUD_SKILL_AUTHORING_INSTRUCTION).not.toContain("Skill creation: Local");

    for (const instruction of [
      OFFLINEGPT_EXTENSION_DISCOVERY_INSTRUCTION,
      OFFLINEGPT_CONNECT_SIGN_IN_INSTRUCTION,
      OFFLINEGPT_CONNECT_DISABLED_INSTRUCTION,
    ]) {
      expect(composeSkillAuthoringInstruction(instruction)).toEqual({
        mode: "local",
        prompt: OFFLINEGPT_LOCAL_SKILL_AUTHORING_INSTRUCTION,
      });
    }
    expect(OFFLINEGPT_LOCAL_SKILL_AUTHORING_INSTRUCTION).toContain("Skill creation: Local");
    expect(OFFLINEGPT_LOCAL_SKILL_AUTHORING_INSTRUCTION).toContain("only when the user requests one");
    expect(OFFLINEGPT_LOCAL_SKILL_AUTHORING_INSTRUCTION).toContain(".opencode/skills/<skill-name>/SKILL.md");
    expect(OFFLINEGPT_LOCAL_SKILL_AUTHORING_INSTRUCTION).not.toContain("Skill creation: Cloud");
  });

  test("keeps neutral steering when provider projection is missing", () => {
    const instruction = composeOfflineGPTExtensionDiscoveryInstruction(state(health({
      usable: true,
      usableByCurrentModel: false,
      phase: "provider_projection_missing",
      firstFailure: {
        code: "provider_tool_projection_missing",
        stage: "provider_projection",
        recommendedAction: "Update OfflineGPT",
        message: "missing",
      },
    })));

    expect(instruction).toBe(OFFLINEGPT_EXTENSION_DISCOVERY_INSTRUCTION);
  });

  test("uses neutral, signed-out, and disabled branches", () => {
    const neutral = composeOfflineGPTExtensionDiscoveryInstruction({ ...state(health({
      usable: false,
      phase: "cloud_tools_missing",
      firstFailure: {
        code: "cloud_tools_missing",
        stage: "tool_registration",
        recommendedAction: "Run reconcile",
        message: "missing",
      },
    })), connectCatalogEnabled: false });
    expect(neutral).toBe(OFFLINEGPT_EXTENSION_DISCOVERY_INSTRUCTION);

    expect(composeOfflineGPTExtensionDiscoveryInstruction({ ...state(health({
      usable: false,
      phase: "missing_desired",
      desired: { present: false, revision: null },
      firstFailure: {
        code: "cloud_mcp_missing",
        stage: "desired_config",
        recommendedAction: "Connect OfflineGPT Cloud",
        message: "missing",
      },
    })), connectCatalogEnabled: false })).toBe(OFFLINEGPT_CONNECT_SIGN_IN_INSTRUCTION);

    expect(composeOfflineGPTExtensionDiscoveryInstruction({ ...state(health({
      usable: false,
      phase: "engine_disabled",
      firstFailure: {
        code: "cloud_mcp_disabled",
        stage: "engine_delivery",
        recommendedAction: "Enable",
        message: "disabled",
      },
    })), connectCatalogEnabled: false })).toBe(OFFLINEGPT_CONNECT_DISABLED_INSTRUCTION);
  });

  test("keeps neutral steering for probe-side server failures", () => {
    expect(composeOfflineGPTExtensionDiscoveryInstruction(state(health({
      usable: false,
      phase: "ready",
      engine: { status: "connected" },
      firstFailure: {
        code: "probe_unreachable",
        stage: "tool_registration",
        recommendedAction: "Check network",
        message: "probe failed",
      },
    })))).toBe(OFFLINEGPT_EXTENSION_DISCOVERY_INSTRUCTION);

    expect(composeOfflineGPTExtensionDiscoveryInstruction(state(health({
      usable: false,
      phase: "cloud_tools_missing",
      engine: { status: "connected" },
      firstFailure: {
        code: "cloud_tools_missing",
        stage: "tool_registration",
        recommendedAction: "Run reconcile",
        message: "missing",
      },
    })))).toBe(OFFLINEGPT_EXTENSION_DISCOVERY_INSTRUCTION);
  });

  test("keeps neutral steering for cloud_tools_missing regardless of server engine health", () => {
    const withoutEngine = composeOfflineGPTExtensionDiscoveryInstruction(state(health({
      usable: false,
      phase: "cloud_tools_missing",
      firstFailure: {
        code: "cloud_tools_missing",
        stage: "tool_registration",
        recommendedAction: "Run reconcile",
        message: "missing",
      },
    })));
    const failedEngine = composeOfflineGPTExtensionDiscoveryInstruction(state(health({
      usable: false,
      phase: "cloud_tools_missing",
      engine: { status: "failed" },
      firstFailure: {
        code: "cloud_tools_missing",
        stage: "tool_registration",
        recommendedAction: "Run reconcile",
        message: "missing",
      },
    })));

    expect(withoutEngine).toBe(OFFLINEGPT_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(failedEngine).toBe(OFFLINEGPT_EXTENSION_DISCOVERY_INSTRUCTION);
  });

  test("treats unknown workspace as neutral instead of borrowing another workspace", () => {
    const instruction = composeOfflineGPTExtensionDiscoveryInstruction({
      ...state(null),
      workspace: { resolution: "unknown", id: null, directory: "/tmp/unknown", reason: "No workspace has this exact OpenCode directory" },
    });
    expect(instruction).toBe(OFFLINEGPT_EXTENSION_DISCOVERY_INSTRUCTION);
  });

  test("never emits degraded wording or no-tool-use guidance", () => {
    const engineStatuses: Array<string | undefined> = [
      "connected",
      "disabled",
      "needs_auth",
      "needs_client_registration",
      "failed",
      "starting",
      undefined,
    ];
    for (const status of engineStatuses) {
      expectNoDegradedSteering(composeSteeringFromEngineMcpStatus(status));
    }

    const fallbackStates: OfflineGPTExtensionConnectState[] = [
      state(health()),
      state(health({ usableByCurrentModel: null })),
      state(health({
        usableByCurrentModel: false,
        phase: "provider_projection_missing",
        firstFailure: failure("provider_tool_projection_missing"),
      })),
      state(health({
        usable: false,
        phase: "engine_disabled",
        firstFailure: failure("cloud_mcp_disabled"),
      })),
      state(health({
        usable: false,
        phase: "missing_desired",
        desired: { present: false, revision: null },
        firstFailure: failure("cloud_desired_missing"),
      })),
      state(health({
        usable: false,
        phase: "missing_mcp",
        firstFailure: failure("cloud_mcp_missing"),
      })),
      state(health({
        usable: false,
        phase: "probe_unreachable",
        firstFailure: failure("probe_unreachable"),
      })),
      state(health({
        usable: false,
        phase: "cloud_tools_missing",
        firstFailure: failure("cloud_tools_missing"),
      })),
      { ...state(null), workspace: { resolution: "unknown", id: null, directory: "/tmp/unknown" } },
      { ...state(null), connectCatalogEnabled: false },
      { ...state(null), googleWorkspace: { legacyConfigured: true } },
      state(null),
    ];
    for (const fallbackState of fallbackStates) {
      expectNoDegradedSteering(composeOfflineGPTExtensionDiscoveryInstruction(fallbackState));
    }
  });
});

describe("resolveOfflineGPTExtensionDiscoveryInstruction", () => {
  test("uses engine connected status without fetching server connect state", async () => {
    const requests: unknown[] = [];
    const client = engineMcpClient({ data: { "offlinegpt-cloud": { status: "connected" } } }, requests);
    let serverFetchCalls = 0;
    const serverFetch = async (): Promise<Response> => {
      serverFetchCalls += 1;
      return Response.json({ message: "unexpected" }, { status: 500 });
    };

    const instruction = await resolveOfflineGPTExtensionDiscoveryInstruction(
      { context: { directory: "/tmp/ws_1" } },
      serverFetch,
      { client, directory: "/tmp/factory" },
    );

    expect(instruction).toBe(OFFLINEGPT_CLOUD_CONNECTION_INSTRUCTION);
    expect(requests).toEqual([{ query: { directory: "/tmp/ws_1" } }]);
    expect(serverFetchCalls).toBe(0);
  });

  test("uses engine auth-needed status without fetching server connect state", async () => {
    const client = engineMcpClient({ data: { "offlinegpt-cloud": { status: "needs_auth" } } });
    let serverFetchCalls = 0;
    const serverFetch = async (): Promise<Response> => {
      serverFetchCalls += 1;
      return Response.json({ message: "unexpected" }, { status: 500 });
    };

    expect(await resolveOfflineGPTExtensionDiscoveryInstruction({}, serverFetch, { client })).toBe(OFFLINEGPT_CONNECT_SIGN_IN_INSTRUCTION);
    expect(serverFetchCalls).toBe(0);
  });

  test("fails open without server fetch when engine status lookup errors", async () => {
    const client: OfflineGPTEngineMcpStatusClient = {
      mcp: {
        status: async () => {
          throw new Error("engine unavailable");
        },
      },
    };
    let serverFetchCalls = 0;
    const serverFetch = async (): Promise<Response> => {
      serverFetchCalls += 1;
      return Response.json({ message: "unexpected" }, { status: 500 });
    };

    expect(await resolveOfflineGPTExtensionDiscoveryInstruction({}, serverFetch, { client })).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(serverFetchCalls).toBe(0);
  });

  test("fails open without server fetch when engine has an unknown offlinegpt-cloud status", async () => {
    const client = engineMcpClient({ data: { "offlinegpt-cloud": { status: "starting" } } });
    let serverFetchCalls = 0;
    const serverFetch = async (): Promise<Response> => {
      serverFetchCalls += 1;
      return Response.json({ message: "unexpected" }, { status: 500 });
    };

    expect(await resolveOfflineGPTExtensionDiscoveryInstruction({}, serverFetch, { client })).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(serverFetchCalls).toBe(0);
  });

  test("falls back to server connect state when engine has no offlinegpt-cloud entry", async () => {
    process.env.OFFLINEGPT_SERVER_URL = "http://offlinegpt.test";
    process.env.OFFLINEGPT_SERVER_TOKEN = "test-token";
    const client = engineMcpClient({ data: { other: { status: "connected" } } });
    let serverFetchCalls = 0;
    const serverFetch = async (): Promise<Response> => {
      serverFetchCalls += 1;
      return Response.json({
        ok: true,
        schemaVersion: 1,
        connectEnabled: true,
        connectCatalogEnabled: true,
        cloudMcpPresent: true,
        cloudHealth: health(),
        workspace: { resolution: "resolved", id: "ws_1", directory: "/tmp/ws_1" },
        googleWorkspace: { legacyConfigured: false },
      });
    };

    expect(await resolveOfflineGPTExtensionDiscoveryInstruction({ context: { directory: "/tmp/ws_1" } }, serverFetch, { client })).toBe(OFFLINEGPT_CLOUD_CONNECTION_INSTRUCTION);
    expect(serverFetchCalls).toBe(1);
  });

  test("fetches verified health for the current directory/model without caching stale failures", async () => {
    process.env.OFFLINEGPT_SERVER_URL = "http://offlinegpt.test/";
    process.env.OFFLINEGPT_SERVER_TOKEN = "test-token";
    const urls: string[] = [];
    const authorizations: Array<string | null> = [];
    let calls = 0;
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      calls += 1;
      urls.push(url);
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return Response.json({
        ok: true,
        schemaVersion: 1,
        connectEnabled: true,
        connectCatalogEnabled: true,
        cloudMcpPresent: calls > 1,
        cloudHealth: calls > 1 ? health() : health({
          usable: false,
          phase: "cloud_tools_missing",
          firstFailure: {
            code: "cloud_tools_missing",
            stage: "tool_registration",
            recommendedAction: "Run reconcile",
            message: "missing",
          },
        }),
        workspace: { resolution: "resolved", id: "ws_1", directory: "/tmp/ws_1" },
        googleWorkspace: { legacyConfigured: false },
      });
    };

    const input = {
      context: { directory: "/tmp/ws_1" },
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    };
    expect(await resolveOfflineGPTExtensionDiscoveryInstruction(input, fakeFetch)).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(await resolveOfflineGPTExtensionDiscoveryInstruction(input, fakeFetch)).toBe(OFFLINEGPT_CLOUD_CONNECTION_INSTRUCTION);
    expect(calls).toBe(2);
    expect(urls).toEqual([
      "http://offlinegpt.test/experimental/connect/state?directory=%2Ftmp%2Fws_1&provider=anthropic&model=claude-sonnet-4",
      "http://offlinegpt.test/experimental/connect/state?directory=%2Ftmp%2Fws_1&provider=anthropic&model=claude-sonnet-4",
    ]);
    expect(authorizations).toEqual(["Bearer test-token", "Bearer test-token"]);
  });

  test("passes workspace id and worktree from plugin context", async () => {
    process.env.OFFLINEGPT_SERVER_URL = "http://offlinegpt.test";
    process.env.OFFLINEGPT_SERVER_TOKEN = "test-token";
    let requested = "";
    const fakeFetch = async (url: string): Promise<Response> => {
      requested = url;
      return Response.json({
        ok: true,
        schemaVersion: 1,
        connectEnabled: true,
        connectCatalogEnabled: true,
        cloudMcpPresent: true,
        cloudHealth: health(),
        workspace: { resolution: "resolved", id: "ws_2", directory: "/tmp/worktree" },
        googleWorkspace: { legacyConfigured: false },
      });
    };

    await resolveOfflineGPTExtensionDiscoveryInstruction({ context: { workspaceId: "ws_2", worktree: "/tmp/worktree" } }, fakeFetch);
    expect(requested).toBe("http://offlinegpt.test/experimental/connect/state?workspaceId=ws_2&directory=%2Ftmp%2Fworktree");
  });

  test("fails open when connect state fetching or parsing fails", async () => {
    process.env.OFFLINEGPT_SERVER_URL = "http://offlinegpt.test";
    process.env.OFFLINEGPT_SERVER_TOKEN = "test-token";
    const failingFetch = async (): Promise<Response> => {
      throw new Error("network unavailable");
    };
    const invalidFetch = async (): Promise<Response> => Response.json({ ok: true });

    expect(await resolveOfflineGPTExtensionDiscoveryInstruction({}, failingFetch)).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(await resolveOfflineGPTExtensionDiscoveryInstruction({}, invalidFetch)).toBe(UNCHANGED_EXTENSION_DISCOVERY_INSTRUCTION);
  });
});
