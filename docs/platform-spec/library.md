# Platform spec: company library

## Skills

- An admin publishes a **skill**: a short name (`slug`, lowercase letters,
  numbers and `-`), a title, a one-line description and the instructions in
  Markdown. Publishing the same slug again replaces it.
- Skills use the policy kind `skill` (baseline **open**): everyone can use a
  skill unless a rule restricts or blocks it.
- Admins list and delete skills. Members list the skills they may use.

## For the agent

- The workspace MCP endpoint offers two more tools:
  - `list_skills`: the skills this member may use (slug, title, description);
  - `use_skill` with a slug: the skill's instructions, or a refusal when the
    member may not use it.
- Every publish and delete is audited.
