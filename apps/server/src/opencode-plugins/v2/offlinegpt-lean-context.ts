// OpenCode v2 plugin: keep per-turn context lean through lazy loading.
//
// v2 already lists Code Mode (MCP and plugin) tools under a 2,000-token budget
// and lets the model `search(...)` for the rest. This plugin extends the same
// "names now, details on demand" rule: rarely used direct tools move behind
// Code Mode, and global skills get one-line catalog entries (loading a skill
// with the `skill` tool still returns its full instructions).
import { LAZY_DIRECT_TOOLS, summarizeSkillDescription } from "./lean-context.js";

type SkillEntry = { id: string; name: string; description?: string };
type ToolEntry = { options?: Record<string, unknown> };
type SetupContext = {
  skill: {
    transform(callback: (editor: {
      list(): SkillEntry[];
      update(id: string, mutate: (skill: SkillEntry) => void): void;
    }) => void): Promise<unknown> | unknown;
  };
  tool: {
    transform(callback: (editor: {
      get(id: string): ToolEntry | undefined;
      update(id: string, mutate: (tool: ToolEntry) => void): void;
    }) => void): unknown;
  };
};

export default {
  id: "offlinegpt.lean-context",
  async setup(context: SetupContext) {
    // Applies to skills in the engine's global registry. On OpenCode v2 2.3.2,
    // workspace and home-folder skills live in per-location registries that
    // plugin transforms do not reach, so their catalog entries stay full length.
    await context.skill.transform((editor) => {
      for (const skill of editor.list()) {
        if (!skill.description) continue;
        const summary = summarizeSkillDescription(skill.description);
        if (summary !== skill.description) editor.update(skill.id, (entry) => { entry.description = summary; });
      }
    });
    return context.tool.transform((editor) => {
      for (const id of LAZY_DIRECT_TOOLS) {
        if (editor.get(id)) editor.update(id, (tool) => { tool.options = { ...tool.options, codemode: true }; });
      }
    });
  },
};
