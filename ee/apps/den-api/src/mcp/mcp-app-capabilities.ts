import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "./mcp-app-v2.js"

/** Advertises the MCP Apps UI extension that the plugin-flow and skill-created apps render through. */
export const mcpAppServerCapabilities = {
  extensions: {
    [EXTENSION_ID]: {
      mimeTypes: [RESOURCE_MIME_TYPE],
    },
  },
}
