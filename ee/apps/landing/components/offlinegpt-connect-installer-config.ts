export const MCP_SERVER_URL = "https://api.offlinegptlabs.com/mcp/agent";
export const CODEX_CONNECTIONS_DEEPLINK = "codex://settings/connections";
export const CHATGPT_SETTINGS_URL = "https://chatgpt.com/#settings/Connectors";
export type OfflineGPTConnectClientId =
  | "cursor"
  | "codex"
  | "chatgpt-desktop"
  | "claude-code"
  | "opencode"
  | "vs-code"
  | "any-client";
export type OfflineGPTConnectSupportStatus = "Verified" | "Setup only";
export type OfflineGPTConnectClientSupport = {
  status: OfflineGPTConnectSupportStatus;
  explanation: string;
};

export const CURSOR_SNIPPET = `${MCP_SERVER_URL}`;

export const CLAUDE_CODE_COMMAND = `claude mcp add --transport http offlinegpt ${MCP_SERVER_URL}`;
export const CODEX_COMMAND = `codex mcp add offlinegpt --url ${MCP_SERVER_URL}`;
export const CODEX_LOGIN_COMMAND = `codex mcp login offlinegpt`;
export const CODEX_RECONNECT_COMMAND = `codex mcp logout offlinegpt
codex mcp login offlinegpt`;

export const OPENCODE_SNIPPET = `{
  "mcp": {
    "offlinegpt": {
      "type": "remote",
      "enabled": true,
      "url": "${MCP_SERVER_URL}",
      "oauth": {}
    }
  }
}`;

export const VS_CODE_COMMAND = `code --add-mcp '{"name":"offlinegpt","type":"http","url":"${MCP_SERVER_URL}"}'`;
export const ANY_CLIENT_COMMAND = `${MCP_SERVER_URL}`;
export const OPENCODE_AUTH_COMMAND = `opencode mcp auth offlinegpt`;
export const OPENCODE_RECONNECT_COMMAND = `opencode mcp logout offlinegpt
opencode mcp auth offlinegpt`;

export const CONNECT_CLIENT_SUPPORT: Record<OfflineGPTConnectClientId, OfflineGPTConnectClientSupport> = {
  "cursor": {
    status: "Setup only",
    explanation: "Setup guide only: paste the server URL into Cursor and start OAuth. Cursor Desktop's cursor://anysphere.cursor-mcp/oauth/callback callback is accepted through an exact allowlist with PKCE S256 enforced. Native proof is not complete."
  },
  "codex": {
    status: "Setup only",
    explanation: "Setup guide only: add OfflineGPT, run codex mcp login offlinegpt, and reconnect with logout then login. Native proof must be rerun on this exact branch."
  },
  "chatgpt-desktop": {
    status: "Setup only",
    explanation: "Setup guide only: paste the URL in ChatGPT Settings > MCP servers and start OAuth there. Native proof is not complete."
  },
  "claude-code": {
    status: "Setup only",
    explanation: "Setup guide only: add the server, then use /mcp in Claude Code to run the client auth flow. Native proof is not complete."
  },
  "opencode": {
    status: "Verified",
    explanation: "Verified with OpenCode native remote MCP OAuth flow."
  },
  "vs-code": {
    status: "Setup only",
    explanation: "Setup guide only: add the server with the VS Code CLI, then start OAuth from VS Code's MCP server prompt. Native proof is not complete."
  },
  "any-client": {
    status: "Setup only",
    explanation: "Setup guide only: use clients that support remote Streamable HTTP MCP servers and OAuth. Native proof depends on the client."
  }
};

export const CONNECT_CLIENTS: OfflineGPTConnectClientId[] = [
  "cursor",
  "codex",
  "chatgpt-desktop",
  "claude-code",
  "opencode",
  "vs-code",
  "any-client"
];
