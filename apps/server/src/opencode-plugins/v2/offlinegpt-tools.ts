// OpenCode v2 build of OfflineGPT's built-in browser, docs and app-control
// tools. v2 only loads plugins that default-export `{ id, setup }` from a
// folder, so this registers the v1 plugins' tools through v2's tool API.
// Their v1 prompt text is carried by the server's per-session instruction
// entry instead (see opencode-v2-instructions.ts).
import { resolve } from "node:path";
import { z } from "zod";
import { OfflineGPTCapabilitiesKnowledge } from "../offlinegpt-capabilities-knowledge.js";
import { server as OfflineGPTBrowser } from "../offlinegpt-chrome-devtools.js";
import { OfflineGPTExtensionsPreview } from "../offlinegpt-extensions-preview.js";
import { createWorkflowTool, type WorkflowSessionApi } from "./workflow-engine.js";

type ToolContent =
  | { type: "text"; text: string }
  | { type: "file"; uri: string; mime: string; name?: string };

type ToolContext = { sessionID: string; messageID: string; signal: AbortSignal };

type V2Tool = {
  name: string;
  description: string;
  input: z.ZodType;
  execute(input: unknown, context: ToolContext): Promise<{ content: string | ToolContent[] }>;
};

type SetupContext = {
  session: Omit<WorkflowSessionApi, "get"> & {
    get(input: { sessionID: string }): Promise<{ location: { directory: string } } & Awaited<ReturnType<WorkflowSessionApi["get"]>>>;
  };
  tool: { transform(callback: (editor: { add(tool: V2Tool): void }) => void): unknown };
};

type V1Tool = {
  description: string;
  args: z.ZodRawShape;
  execute(args: unknown, context: unknown): Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The v1 plugins may read their workspace from the factory, so build them once per workspace. */
async function createV1Tools(directory: string): Promise<Record<string, V1Tool>> {
  const factoryInput = { directory };
  const [browser, knowledge, extensions] = await Promise.all([
    OfflineGPTBrowser(),
    OfflineGPTCapabilitiesKnowledge(),
    OfflineGPTExtensionsPreview(factoryInput),
  ]);
  return { ...browser.tool, ...knowledge.tool, ...extensions.tool };
}

/** v1 tools return text or `{ output, attachments }`; v2 tools return content parts. */
function toContent(result: unknown): string | ToolContent[] {
  if (typeof result === "string") return result;
  if (!isRecord(result)) return JSON.stringify(result);
  const content: ToolContent[] = [{ type: "text", text: typeof result.output === "string" ? result.output : JSON.stringify(result) }];
  for (const attachment of Array.isArray(result.attachments) ? result.attachments : []) {
    if (!isRecord(attachment) || typeof attachment.url !== "string" || typeof attachment.mime !== "string") continue;
    content.push({
      type: "file",
      uri: attachment.url,
      mime: attachment.mime,
      ...(typeof attachment.filename === "string" ? { name: attachment.filename } : {}),
    });
  }
  return content;
}

export default {
  id: "offlinegpt.tools",
  async setup(context: SetupContext) {
    // One engine serves every workspace, so each call resolves its session's folder.
    const toolsByDirectory = new Map<string, Promise<Record<string, V1Tool>>>();
    const forSession = async (sessionID: string) => {
      const directory = resolve((await context.session.get({ sessionID })).location.directory);
      let tools = toolsByDirectory.get(directory);
      if (!tools) {
        tools = createV1Tools(directory);
        toolsByDirectory.set(directory, tools);
      }
      return { directory, tools: await tools };
    };

    // Tool names, descriptions and schemas do not depend on the workspace.
    const v1Tools = await createV1Tools(process.cwd());
    const tools: V2Tool[] = Object.entries(v1Tools).map(([name, tool]) => ({
      name,
      description: tool.description,
      input: z.object(tool.args),
      async execute(input, toolContext) {
        const { directory, tools: workspaceTools } = await forSession(toolContext.sessionID);
        const result = await workspaceTools[name].execute(input, {
          sessionID: toolContext.sessionID,
          messageID: toolContext.messageID,
          directory,
          abort: toolContext.signal,
        });
        return { content: toContent(result) };
      },
    }));

    tools.push(createWorkflowTool(context.session));

    return context.tool.transform((editor) => {
      for (const tool of tools) editor.add(tool);
    });
  },
};
