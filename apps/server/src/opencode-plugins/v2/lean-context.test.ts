import { describe, expect, test } from "bun:test";
import { SKILL_SUMMARY_MAX_CHARS, summarizeSkillDescription } from "./lean-context.js";

describe("skill catalog summaries", () => {
  test("keeps a short first sentence as is", () => {
    expect(summarizeSkillDescription("Create Word documents. Use it for reports and letters.")).toBe("Create Word documents.");
  });

  test("cuts a long single sentence at a word boundary within the budget", () => {
    const long = "Read this skill before the first step that uses the built-in browser, the browser pane inside the desktop app (also called the in-app browser or the browser pane), whose tools are named in a particular way";
    const summary = summarizeSkillDescription(long);
    expect(summary.length).toBeLessThanOrEqual(SKILL_SUMMARY_MAX_CHARS);
    expect(summary.endsWith("…")).toBe(true);
    expect(long.startsWith(summary.slice(0, -1))).toBe(true);
    expect(summary).not.toMatch(/[,;:\s]…$/);
  });

  test("collapses whitespace and leaves short descriptions unchanged", () => {
    expect(summarizeSkillDescription("  Make\n slides   ")).toBe("Make slides");
  });
});
