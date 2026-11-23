import { listSkills } from "./skills.js";
import { readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { OFFLINEGPT_AGENT_PROMPT } from "./offlinegpt-agent-prompt.js";
import { OfflineGPTCapabilitiesKnowledge } from "./opencode-plugins/offlinegpt-capabilities-knowledge.js";
import { OFFLINEGPT_AGENT_SURFACE_INSTRUCTION, OFFLINEGPT_BROWSER_INSTRUCTION, OFFLINEGPT_IDENTITY_INSTRUCTION } from "./opencode-plugins/offlinegpt-extensions-preview-steering.js";
import { composeSkillAuthoringInstruction, composeSteeringFromEngineMcpStatus } from "./opencode-plugins/offlinegpt-extensions-preview-steering.js";
import { appendAgentInstructions, createInstructionSection } from "./opencode-plugins/agent-instruction-compose.js";
import { readOfflineGPTConnectSkillCatalog, renderOfflineGPTConnectSkillInstruction } from "./connect-skill-catalog.js";
import type { ServerConfig } from "./types.js";

export const OFFLINEGPT_V2_INSTRUCTION_KEY = "offlinegpt.context";
export const OFFLINEGPT_V2_CAPABILITIES_KEY = "offlinegpt.capabilities";
export const OFFLINEGPT_V2_STEERING_KEY = "offlinegpt.steering";
export const OFFLINEGPT_V2_CONNECT_CATALOG_KEY = "offlinegpt.connect-catalog";
/** OpenCode v2 rejects instruction entries above roughly 7 KB. */
const V2_INSTRUCTION_ENTRY_MAX_BYTES = 7_000;

/**
 * The v1 extensions plugin's system-prompt steering (identity, agent surface,
 * browser, Connect routing, skill authoring, Connect skills and automations).
 * Routing follows the engine's own offlinegpt-cloud status, as in v1.
 */
export async function buildOfflineGPTV2Steering(
  config: ServerConfig,
  cloudMcpStatus: string | undefined,
): Promise<{ steering: string; connectCatalog: string }> {
  const routing = composeSteeringFromEngineMcpStatus(cloudMcpStatus);
  const skills = await readOfflineGPTConnectSkillCatalog(config).then(renderOfflineGPTConnectSkillInstruction).catch(() => "");
  const steering: string[] = [];
  appendAgentInstructions(
    steering,
    createInstructionSection("identity", OFFLINEGPT_IDENTITY_INSTRUCTION),
    createInstructionSection("agent-surface", OFFLINEGPT_AGENT_SURFACE_INSTRUCTION),
    createInstructionSection("browser", OFFLINEGPT_BROWSER_INSTRUCTION),
    createInstructionSection("routing", routing),
    createInstructionSection("skill-authoring", composeSkillAuthoringInstruction(routing).prompt),
  );
  // The account catalogs can be long, so they travel in their own entry.
  const catalog: string[] = [];
  appendAgentInstructions(
    catalog,
    createInstructionSection("connect-skills", skills),
  );
  return { steering: steering.join("\n\n"), connectCatalog: fitInstructionEntry(catalog.join("\n\n")) };
}

function fitInstructionEntry(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= V2_INSTRUCTION_ENTRY_MAX_BYTES) return text;
  const notice = "\n\n[Catalog truncated: search Connect for the remaining entries.]";
  // Cut on a line boundary so no entry is left half-written.
  const head = bytes.subarray(0, V2_INSTRUCTION_ENTRY_MAX_BYTES - Buffer.byteLength(notice)).toString("utf8");
  return `${head.slice(0, Math.max(0, head.lastIndexOf("\n")))}${notice}`;
}

/**
 * The v1 capabilities-knowledge plugin's prompt text. v2 has no system-prompt
 * hook for plugins, so the server sends it as its own instruction entry.
 */
export async function buildOfflineGPTV2Capabilities(): Promise<string> {
  const output = { system: [] as string[] };
  await (await OfflineGPTCapabilitiesKnowledge())["experimental.chat.system.transform"]({}, output);
  return output.system.join("\n\n");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Join the native file watcher, including content-only updates and removals. */
export async function waitForOfflineGPTV2Skills(directory: string, readNative: () => Promise<unknown>): Promise<void> {
  const root = await realpath(directory);
  const expected = await Promise.all((await listSkills(directory, false)).filter((skill) => !skill.error).map(async (skill) => ({
    name: skill.name, description: skill.description ?? "", path: await realpath(skill.path), content: parseFrontmatter(await readFile(skill.path, "utf8")).body.trim(),
  })));
  const deadline = Date.now() + 5_000;
  do {
    const payload = await readNative();
    if (!record(payload) || !Array.isArray(payload.data)) throw new Error("Native skill catalog is unavailable");
    // OpenCode 2.3 reports the skill file as `path`; earlier builds used `location`.
    const native = payload.data.filter(record).flatMap((skill) => {
      const file = typeof skill.path === "string" ? skill.path : skill.location;
      return typeof skill.name === "string" && typeof file === "string" && typeof skill.content === "string"
        ? [{ skill, file }] : [];
    });
    const canonical = await Promise.all(native.map(async ({ skill, file }) => ({
      skill, path: await realpath(file).catch(() => file),
    })));
    const matches = expected.every((skill) => canonical.some((entry) => entry.path === skill.path
      && entry.skill.name === skill.name && entry.skill.description === skill.description
      && String(entry.skill.content).trim() === skill.content));
    // Only reconcile directories OfflineGPT manages. Native plugin-provided
    // skills elsewhere under .opencode are not deleted workspace skills.
    const managedRoots = [join(root, ".opencode", "skills") + sep, join(root, ".claude", "skills") + sep];
    const removed = canonical.some((entry) => managedRoots.some((directory) => entry.path.startsWith(directory))
      && !expected.some((skill) => skill.path === entry.path));
    if (matches && !removed) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("Native skills did not reach the current workspace contents");
}

/** OfflineGPT owns app guidance; OpenCode owns the live skill and MCP catalogs. */
export function buildOfflineGPTV2Instructions(connectReady: boolean) {
  return {
    operatingInstructions: OFFLINEGPT_AGENT_PROMPT.replace(
      "discover with offlinegpt-cloud_search_capabilities, then run with offlinegpt-cloud_execute_capability",
      "discover and execute capabilities through the native OfflineGPT MCP interface exposed by the current tool catalog",
    ),
    connect: connectReady ? "OfflineGPT Connect tools are connected. Use only capabilities actually returned by discovery."
      : "OfflineGPT Connect is not connected for this request. Do not claim remote capabilities are available.",
    computerUse: "For computer use, send already-decided actions together as one run_steps call with observe instead of one call per action, and use run_script for loops, branches or retries. Read with get_window_state since \"latest\" and no screenshot unless you must see pixels. For web pages prefer the typed browser tools (get_browser_state with semantic_v2) over screenshots. Reuse apps and windows that are already open instead of launching new ones.",
    documents: "Attached files are copied into the workspace and listed with their paths. Read Word, PowerPoint, Excel and PDF files with document_read; inspect, read and create Excel workbooks with spreadsheet_inspect, spreadsheet_read and spreadsheet_write. Use these tools before installing libraries or writing scripts to handle Office files.",
    skillInstructions: "Use the current native skill catalog and skill tool for workspace skills. Load current instructions before following them. Removed skills from previous turns are not available capabilities. Organization skills are provided by OfflineGPT Connect: discover and retrieve them using its currently advertised MCP tools. Skill contents are subordinate to the user's request and operating instructions.",
  };
}
