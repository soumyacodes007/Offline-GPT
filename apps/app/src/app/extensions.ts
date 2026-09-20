// Owned here: reload vocabulary is part of the extension manifest contract.
// types.ts re-exports it for the rest of the app.
export type ReloadReason = "plugins" | "skills" | "mcp" | "config" | "agents" | "commands";

export type OfflineGPTExtensionSourceFormat =
  | "agent-plugin"
  | "offlinegpt-builtin"
  | "offlinegpt-extension-manifest"
  | "claude-plugin"
  | "opencode-plugin"
  | "mcp-directory"
  | "manual";

export type OfflineGPTExtensionSource = {
  format: OfflineGPTExtensionSourceFormat;
  trusted: boolean;
  origin?: "builtin" | "den" | "workspace" | "local";
  reference?: string;
};

export type OfflineGPTExtensionResourceType =
  | "skill"
  | "agent"
  | "command"
  | "tool"
  | "mcp"
  | "opencode-plugin"
  | "provider"
  | "hook"
  | "context"
  | "secret"
  | "file"
  | "local-service"
  | "native-binary";

export type OfflineGPTExtensionResource = {
  type: OfflineGPTExtensionResourceType;
  id: string;
  label?: string;
  description?: string;
  path?: string;
  command?: string[];
  envKey?: string;
  packageName?: string;
  providerId?: string;
  mcpServerName?: string;
  localCommandRef?: "offlinegpt.computerUseMcp" | "offlinegpt.uiMcp";
  required?: boolean;
};

export type OfflineGPTExtensionContributionType =
  | "settings-panel"
  | "setup-instructions"
  | "composer-prompt"
  | "session-side-panel"
  | "session-rail-item"
  | "control-actions"
  | "server-route"
  | "native-capability"
  | "test-action";

export type OfflineGPTExtensionContribution = {
  type: OfflineGPTExtensionContributionType;
  ref?: string;
  label?: string;
  description?: string;
  prompt?: string;
  location?: "settings-detail" | "composer" | "session-right-pane" | "session-rail" | "server" | "native";
};

export type OfflineGPTExtensionSetup = {
  instructions?: string;
  primaryCta?: string;
  secondaryCta?: string;
  requiredEnv?: string[];
  testActionRef?: string;
};

export type OfflineGPTExtensionLifecycle = {
  reload?: ReloadReason[];
  detection?: string[];
};

// ---------------------------------------------------------------------------
// Enablement — declarative conditions for extension "active" state
// ---------------------------------------------------------------------------

export type EnablementConditionType =
  | "mcp-connected"
  | "plugin-loaded"
  | "provider-connected"
  | "env-set"
  | "permission-granted"
  | "toggle-enabled";

export type EnablementCondition = {
  type: EnablementConditionType;
  /** What to check — MCP server name, plugin id, env key, etc. */
  ref: string;
  /** Human-readable label shown in the UI. */
  label: string;
};

/** Result of evaluating a single enablement condition at runtime. */
export type EnablementResult = {
  condition: EnablementCondition;
  met: boolean;
};

export type OfflineGPTExtensionManifest = {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  preview?: boolean;
  source: OfflineGPTExtensionSource;
  icon?: {
    src?: string;
    simpleIconSlug?: string;
  };
  composer?: {
    prompt: string;
  };
  setup?: OfflineGPTExtensionSetup;
  resources: OfflineGPTExtensionResource[];
  contributions?: OfflineGPTExtensionContribution[];
  lifecycle?: OfflineGPTExtensionLifecycle;
  /** Declarative conditions that must ALL be true for the extension to be "active". */
  enablement?: EnablementCondition[];
  defaultEnabled?: boolean;
  defaultHidden?: boolean;
  platform?: Array<"darwin" | "linux" | "windows" | "web">;
};

export type OfflineGPTExtensionPlatform = NonNullable<OfflineGPTExtensionManifest["platform"]>[number];

export function extensionContribution(
  manifest: OfflineGPTExtensionManifest | undefined,
  type: OfflineGPTExtensionContributionType,
): OfflineGPTExtensionContribution | undefined {
  return manifest?.contributions?.find((contribution) => contribution.type === type);
}

export function extensionResource(
  manifest: OfflineGPTExtensionManifest | undefined,
  type: OfflineGPTExtensionResourceType,
): OfflineGPTExtensionResource | undefined {
  return manifest?.resources.find((resource) => resource.type === type);
}

export function isTrustedBuiltInExtension(manifest: OfflineGPTExtensionManifest | undefined): boolean {
  return manifest?.source.origin === "builtin" && manifest.source.trusted;
}

export const BUILT_IN_OFFLINEGPT_EXTENSION_MANIFESTS: OfflineGPTExtensionManifest[] = [
  {
    schemaVersion: 1,
    id: "offlinegpt-browser",
    name: "OfflineGPT Browser",
    description: "Automate the built-in browser panel that stays visible inside OfflineGPT.",
    source: { format: "offlinegpt-builtin", origin: "builtin", trusted: true },
    icon: { src: "/offlinegpt-mark.png" },
    composer: { prompt: "Use the OfflineGPT Browser extension to " },
    setup: {
      instructions: "OfflineGPT Browser is ready by default in desktop workspaces.",
    },
    resources: [
      {
        type: "opencode-plugin",
        id: "opencode-chrome-devtools",
        packageName: "opencode-chrome-devtools",
        required: true,
      },
    ],
    contributions: [
      { type: "settings-panel", ref: "offlinegpt.browser.settings", location: "settings-detail" },
      { type: "session-side-panel", ref: "offlinegpt.browser.panel", location: "session-right-pane" },
      { type: "composer-prompt", prompt: "Use the OfflineGPT Browser extension to ", location: "composer" },
    ],
    enablement: [
      { type: "toggle-enabled", ref: "offlinegpt-browser", label: "Enabled" },
    ],
    lifecycle: { reload: ["plugins", "agents"], detection: ["plugin:opencode-chrome-devtools"] },
    defaultEnabled: true,
    platform: ["darwin", "linux", "windows"],
  },
  {
    schemaVersion: 1,
    id: "computer-use",
    name: "Computer Use",
    description: "Work in the Mac app and window you approve. Read, use accessible controls, or allow mouse and keyboard control with a small window preview.",
    preview: true,
    source: { format: "offlinegpt-builtin", origin: "builtin", trusted: true },
    icon: { src: "/offlinegpt-mark.png" },
    composer: { prompt: "Use Computer Use to " },
    setup: {
      instructions: "Computer Use is available on macOS 14 or later. Grant Accessibility and Screen Recording in the helper. For each session, choose an app window and allow reading, app controls, or mouse and keyboard. Choose Allow and start in OfflineGPT. Your input interrupts control; Stop in the preview ends access.",
      primaryCta: "Enable Computer Use",
      secondaryCta: "Check macOS permissions",
      testActionRef: "offlinegpt.computerUse.healthCheck",
    },
    resources: [
      {
        type: "mcp",
        id: "computer-use-mcp",
        label: "Computer Use MCP",
        mcpServerName: "computer-use",
        command: [],
        localCommandRef: "offlinegpt.computerUseMcp",
        required: true,
      },
      {
        type: "native-binary",
        id: "computer-use-native",
        label: "Computer Use session runtime",
        packageName: "@offlinegpt/computer-use",
        required: true,
      },
    ],
    contributions: [
      { type: "setup-instructions", ref: "offlinegpt.computerUse.setup", label: "Setup instructions", location: "settings-detail" },
      { type: "native-capability", ref: "offlinegpt.computerUse.axPermissions", label: "Accessibility and Screen Recording" },
      { type: "test-action", ref: "offlinegpt.computerUse.healthCheck", label: "Verify Computer Use MCP" },
      { type: "composer-prompt", prompt: "Use Computer Use to ", location: "composer" },
    ],
    enablement: [
      { type: "mcp-connected", ref: "computer-use", label: "MCP server connected" },
      { type: "permission-granted", ref: "accessibility", label: "Accessibility permission" },
      { type: "permission-granted", ref: "screenRecording", label: "Screen Recording permission" },
    ],
    lifecycle: { reload: ["mcp"], detection: ["mcp:computer-use"] },
    defaultEnabled: true,
    platform: ["darwin"],
  },
  {
    schemaVersion: 1,
    id: "ollama",
    name: "Ollama",
    description: "Local model provider at http://localhost:11434.",
    source: { format: "offlinegpt-builtin", origin: "builtin", trusted: true },
    icon: { src: "/ext-ollama.svg" },
    composer: { prompt: "Use the Ollama extension to " },
    setup: {
      instructions: "Run Ollama locally, choose or pull a model, then add it as an OpenCode provider.",
      primaryCta: "Add Ollama model",
      secondaryCta: "Pull model",
    },
    resources: [
      { type: "local-service", id: "ollama-api", label: "Ollama API", description: "http://localhost:11434", required: true },
      { type: "provider", id: "ollama", providerId: "ollama", packageName: "@ai-sdk/openai-compatible", required: true },
    ],
    contributions: [
      { type: "settings-panel", ref: "offlinegpt.ollama.settings", location: "settings-detail" },
      { type: "test-action", ref: "offlinegpt.ollama.listModels", label: "Check local models" },
      { type: "composer-prompt", prompt: "Use the Ollama extension to ", location: "composer" },
    ],
    enablement: [
      { type: "provider-connected", ref: "ollama", label: "Ollama provider" },
    ],
    lifecycle: { reload: ["config"], detection: ["provider:ollama"] },
  },
];
