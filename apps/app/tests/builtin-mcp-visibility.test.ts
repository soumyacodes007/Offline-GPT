import { describe, expect, test } from "bun:test";

import { MCP_QUICK_CONNECT } from "../src/app/constants";

describe("built-in OfflineGPT MCP visibility", () => {
  test("hides internal OfflineGPT MCPs and omits the retired admin connector", () => {
    expect(MCP_QUICK_CONNECT.find((entry) => entry.serverName === "offlinegpt-cloud")?.defaultHidden).toBe(true);
    expect(MCP_QUICK_CONNECT.find((entry) => entry.serverName === "offlinegpt-admin")).toBeUndefined();
    expect(MCP_QUICK_CONNECT.find((entry) => entry.serverName === "offlinegpt-ui")?.defaultHidden).toBe(true);
  });

  test("keeps directory apps visible by default", () => {
    expect(MCP_QUICK_CONNECT.find((entry) => entry.serverName === "notion")?.defaultHidden).toBeUndefined();
    expect(MCP_QUICK_CONNECT.find((entry) => entry.serverName === "linear")?.defaultHidden).toBeUndefined();
  });
});
