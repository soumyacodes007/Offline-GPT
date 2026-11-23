// Lazy-loading helpers for the lean-context plugin, kept out of the plugin entry
// so the entry has a single default export.

/** Catalog entries keep about one line; loading the skill returns everything. */
export const SKILL_SUMMARY_MAX_CHARS = 160;

/**
 * Direct tools that most turns never use. Moving them into Code Mode drops
 * their schemas from every request without removing them.
 */
export const LAZY_DIRECT_TOOLS = ["experimental_image_generate"];

/** The first sentence, cut at a word boundary to fit the catalog line. */
export function summarizeSkillDescription(description: string, max = SKILL_SUMMARY_MAX_CHARS): string {
  const text = description.replace(/\s+/g, " ").trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > max / 2 ? cut.slice(0, boundary) : cut).replace(/[,;:\s]+$/, "")}…`;
}
