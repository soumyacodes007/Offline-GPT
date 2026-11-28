import { strFromU8, unzipSync } from "fflate";
import { z } from "zod";

/**
 * Reads a plugin `.zip` in the Claude plugin layout. Only three kinds of file
 * are read; nothing in the archive is executed.
 */
export const MAX_PLUGIN_BYTES = 20 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;

export type ParsedSkill = { name: string; title: string; description: string; instructions: string };
export type ParsedConnection = { name: string; url: string; header: { name: string; value: string } | null; needsCredential: boolean };
export type ParsedPlugin = {
  slug: string;
  title: string;
  description: string;
  version: string | null;
  skills: ParsedSkill[];
  connections: ParsedConnection[];
  skipped: string[];
};

const manifestSchema = z.object({ name: z.string().trim().min(1), description: z.string().optional(), version: z.string().optional() });
const mcpFileSchema = z.object({ mcpServers: z.record(z.string(), z.record(z.string(), z.unknown())) });
const remoteServerSchema = z.object({ url: z.url({ protocol: /^https?$/ }), headers: z.record(z.string(), z.string()).optional() });

/** Lowercase, `-` for anything else, trimmed; empty when nothing usable is left. */
export function slugify(value: string, max = 32): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
}

/** Splits `---` front matter (simple `key: value` lines) from the body. */
export function readFrontMatter(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (field?.[1]) fields[field[1]] = (field[2] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { fields, body: (match[2] ?? "").trim() };
}

function unpack(bytes: Uint8Array): Map<string, Uint8Array> {
  let total = 0;
  const files = unzipSync(bytes, {
    filter: (file) => {
      total += file.originalSize;
      if (total > MAX_UNPACKED_BYTES) throw new Error("The plugin unpacks to more than 50 MB.");
      return !file.name.endsWith("/") && !file.name.includes("..");
    },
  });
  const entries = Object.entries(files).map(([name, data]) => [name.replaceAll("\\", "/").replace(/^\/+/, ""), data] as const);
  // The manifest sits at the top, or inside one folder (as made by zipping the plugin's folder).
  const manifestPath = entries.map(([name]) => name).find((name) => /^([^/]+\/)?\.claude-plugin\/plugin\.json$/.test(name)) ?? "";
  const prefix = manifestPath.slice(0, manifestPath.length - ".claude-plugin/plugin.json".length);
  return new Map(entries.filter(([name]) => name.startsWith(prefix)).map(([name, data]) => [name.slice(prefix.length), data]));
}

export function parsePlugin(bytes: Uint8Array): ParsedPlugin {
  if (bytes.byteLength > MAX_PLUGIN_BYTES) throw new Error("The plugin is larger than 20 MB.");
  let files: Map<string, Uint8Array>;
  try {
    files = unpack(bytes);
  } catch (error) {
    throw new Error(error instanceof Error && error.message.startsWith("The plugin") ? error.message : "That file isn't a readable .zip.");
  }
  const manifestBytes = files.get(".claude-plugin/plugin.json");
  if (!manifestBytes) throw new Error("The zip has no .claude-plugin/plugin.json.");
  const manifest = manifestSchema.safeParse(JSON.parse(strFromU8(manifestBytes)));
  if (!manifest.success) throw new Error("plugin.json needs a `name`.");
  const slug = slugify(manifest.data.name, 24);
  if (!slug) throw new Error("plugin.json's `name` has no usable letters or numbers.");

  const skipped: string[] = [];
  const skills: ParsedSkill[] = [];
  for (const [path, data] of files) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/i.exec(path);
    if (!match?.[1]) continue;
    const { fields, body } = readFrontMatter(strFromU8(data));
    const name = slugify(fields.name ?? match[1]);
    if (!name || !body) {
      skipped.push(`${path}: no name or no instructions`);
      continue;
    }
    skills.push({ name, title: fields.name ?? match[1], description: (fields.description ?? fields.name ?? match[1]).slice(0, 500), instructions: body });
  }

  const connections: ParsedConnection[] = [];
  const mcpBytes = files.get(".mcp.json");
  if (mcpBytes) {
    const mcp = mcpFileSchema.safeParse(JSON.parse(strFromU8(mcpBytes)));
    if (!mcp.success) skipped.push(".mcp.json: no `mcpServers` object");
    for (const [serverName, server] of Object.entries(mcp.success ? mcp.data.mcpServers : {})) {
      const remote = remoteServerSchema.safeParse(server);
      const name = slugify(serverName);
      if (!remote.success || !name) {
        skipped.push(`MCP server "${serverName}": runs a local command or has no http(s) URL`);
        continue;
      }
      const headers = Object.entries(remote.data.headers ?? {});
      const usable = headers.filter(([, value]) => !value.includes("${"));
      if (headers.length > 1) skipped.push(`MCP server "${serverName}": only its first header is kept`);
      const [first] = usable;
      connections.push({ name, url: remote.data.url, header: first ? { name: first[0], value: first[1] } : null, needsCredential: headers.length > usable.length });
    }
  }
  return { slug, title: manifest.data.name, description: manifest.data.description ?? manifest.data.name, version: manifest.data.version ?? null, skills, connections, skipped };
}
