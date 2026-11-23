// OpenCode v2 build of OfflineGPT's document tools. v2 only loads plugins that
// default-export `{ id, setup }` from a folder, and it has no hook to rewrite
// chat messages, so this wraps the v1 spreadsheet and PDF tools and exposes the
// v1 Office/PDF attachment conversion as a `document_read` tool instead.
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { OfflineGPTOfficeAttachments } from "../offlinegpt-office-attachments.js";
import { OfflineGPTPdfAttachments } from "../offlinegpt-pdf-attachments.js";
import { OfflineGPTSpreadsheets } from "../offlinegpt-spreadsheets.js";

type ToolContent =
  | { type: "text"; text: string }
  | { type: "file"; uri: string; mime: string; name?: string };

type ToolContext = { sessionID: string; signal: AbortSignal };

type V2Tool = {
  name: string;
  description: string;
  input: z.ZodType;
  execute(input: unknown, context: ToolContext): Promise<{ content: string | ToolContent[] }>;
};

type SetupContext = {
  session: { get(input: { sessionID: string }): Promise<{ location: { directory: string } }> };
  tool: { transform(callback: (editor: { add(tool: V2Tool): void }) => void): unknown };
};

type V1Tool = {
  description: string;
  args: z.ZodRawShape;
  execute(args: unknown, context: unknown): Promise<unknown>;
};

type MessagesTransform = (input: unknown, output: { messages: unknown[] }) => Promise<void>;

const DOCUMENT_MIMES: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pdf": "application/pdf",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The v1 plugins read their workspace from the factory, so build them once per workspace. */
async function createV1Plugins(directory: string) {
  const factoryInput = { directory };
  const [spreadsheets, pdf, office] = await Promise.all([
    OfflineGPTSpreadsheets(factoryInput),
    OfflineGPTPdfAttachments(factoryInput),
    OfflineGPTOfficeAttachments(factoryInput),
  ]);
  const tools: Record<string, V1Tool> = { ...spreadsheets.tool, ...pdf.tool };
  const readOffice: MessagesTransform = office["experimental.chat.messages.transform"];
  const readPdf: MessagesTransform = pdf["experimental.chat.messages.transform"];
  return { tools, readOffice, readPdf };
}

type V1Plugins = Awaited<ReturnType<typeof createV1Plugins>>;

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

function textOf(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.parts)) return "";
  return message.parts
    .flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n\n");
}

async function readDocument(directory: string, plugins: V1Plugins, path: string): Promise<string> {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(directory, path);
  const inside = relative(directory, absolute);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`${path} is outside this workspace.`);
  const mime = DOCUMENT_MIMES[extname(absolute).toLowerCase()];
  if (!mime) throw new Error(`document_read supports .docx, .pptx, .xlsx and .pdf files, not ${JSON.stringify(basename(absolute))}.`);
  const output = {
    messages: [{
      info: { role: "user" },
      parts: [{ type: "file", mime, url: pathToFileURL(absolute).href, filename: basename(absolute) }],
    }],
  };
  await (mime === "application/pdf" ? plugins.readPdf : plugins.readOffice)({}, output);
  return textOf(output.messages[0]) || `No text could be extracted from ${basename(absolute)}.`;
}

const DOCUMENT_READ_DESCRIPTION = "Read the text of a Word (.docx), PowerPoint (.pptx), Excel (.xlsx) or PDF (.pdf) file in this workspace, such as a file the user attached (use the path from the attached-files note). For Excel, follow up with spreadsheet_inspect and spreadsheet_read; for PDF tables, figures or scans, follow up with the PDF page tool.";

export default {
  id: "offlinegpt.office",
  async setup(context: SetupContext) {
    // One engine serves every workspace, so each call resolves its session's folder.
    const pluginsByDirectory = new Map<string, Promise<V1Plugins>>();
    const forSession = async (sessionID: string) => {
      const directory = resolve((await context.session.get({ sessionID })).location.directory);
      let plugins = pluginsByDirectory.get(directory);
      if (!plugins) {
        plugins = createV1Plugins(directory);
        pluginsByDirectory.set(directory, plugins);
      }
      return { directory, plugins: await plugins };
    };

    // Tool names, descriptions and schemas do not depend on the workspace.
    const { tools: v1Tools } = await createV1Plugins(process.cwd());
    const tools: V2Tool[] = Object.entries(v1Tools).map(([name, tool]) => ({
      name,
      description: tool.description,
      input: z.object(tool.args),
      async execute(input, toolContext) {
        const { directory, plugins } = await forSession(toolContext.sessionID);
        const result = await plugins.tools[name].execute(input, { sessionID: toolContext.sessionID, directory, abort: toolContext.signal });
        return { content: toContent(result) };
      },
    }));
    tools.push({
      name: "document_read",
      description: DOCUMENT_READ_DESCRIPTION,
      input: z.object({
        path: z.string().min(1).describe("Workspace-relative or absolute path of the document inside this workspace."),
      }),
      async execute(input, toolContext) {
        const { path } = z.object({ path: z.string() }).parse(input);
        const { directory, plugins } = await forSession(toolContext.sessionID);
        return { content: await readDocument(directory, plugins, path) };
      },
    });

    return context.tool.transform((editor) => {
      for (const tool of tools) editor.add(tool);
    });
  },
};
