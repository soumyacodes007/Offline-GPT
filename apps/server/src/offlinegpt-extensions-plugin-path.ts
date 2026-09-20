import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare global {
  namespace NodeJS {
    interface Process {
      resourcesPath?: string;
    }
  }
}

function resourcesPathFromAppAsarPath(path: string): string | null {
  const match = /[\\/]app\.asar(?:[\\/]|$)/.exec(path);
  return match ? path.slice(0, match.index) : null;
}

export function offlinegptPluginPath(name: string, here?: string): string {
  const pluginDir = process.env.OFFLINEGPT_EXTENSIONS_PLUGIN_DIR;
  if (pluginDir) {
    return join(pluginDir, `${name}.js`);
  }

  here = here ?? dirname(fileURLToPath(import.meta.url));
  const resourcesPath = resourcesPathFromAppAsarPath(here);
  if (resourcesPath) {
    const electronResourcesPath = process.resourcesPath?.includes("app.asar") ? resourcesPath : process.resourcesPath?.trim();
    return join(electronResourcesPath || resourcesPath, "opencode-plugins", `${name}.js`);
  }

  const extension = basename(here) === "dist" ? "js" : "ts";
  return join(here, "opencode-plugins", `${name}.${extension}`);
}

export const offlinegptExtensionsPreviewPluginPath = () => offlinegptPluginPath("offlinegpt-extensions-preview");
export const offlinegptChromeDevtoolsPluginPath = () => offlinegptPluginPath("offlinegpt-chrome-devtools");
export const offlinegptCapabilitiesKnowledgePluginPath = () => offlinegptPluginPath("offlinegpt-capabilities-knowledge");
export const offlinegptAnthropicAdaptiveThinkingPluginPath = () => offlinegptPluginPath("offlinegpt-anthropic-adaptive-thinking");
export const offlinegptAnthropicToolSchemaPluginPath = () => offlinegptPluginPath("offlinegpt-anthropic-tool-schema");
export const offlinegptOfficeAttachmentsPluginPath = () => offlinegptPluginPath("offlinegpt-office-attachments");
export const offlinegptSpreadsheetsPluginPath = () => offlinegptPluginPath("offlinegpt-spreadsheets");
export const offlinegptPdfAttachmentsPluginPath = () => offlinegptPluginPath("offlinegpt-pdf-attachments");
export const offlinegptTitleRecoveryPluginPath = () => offlinegptPluginPath("offlinegpt-title-recovery");
