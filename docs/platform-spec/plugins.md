# Platform spec: library plugins

A plugin is a bundle of skills and tool connections that admins install and
grant together, in the Claude plugin layout the desktop app already uses.

## Installing

- An admin uploads a plugin as a `.zip` (at most 20 MB). It may contain one
  top-level folder; inside it the platform reads:
  - `.claude-plugin/plugin.json`: `name` (required), `description`, `version`;
  - `skills/<folder>/SKILL.md`: front matter `name` and `description`, then
    the instructions;
  - `.mcp.json`: `mcpServers`, each with a `url` (`http`/`https`) and optional
    `headers`. Servers that run a local command instead of a URL are skipped
    and reported, since workspaces only reach tools over the network.
- The plugin's slug is its `name`, lowercased with other characters turned
  into `-`. Its items become library skills and connections named
  `<plugin>-<item>`.
- A header whose value contains `${…}` (a placeholder) is not stored; the
  connection is installed without it and reported as needing a credential,
  which an admin sets on the Connections form.
- Installing the same plugin again replaces it: items no longer in the zip are
  removed.
- The response lists what was installed and anything skipped, with the reason.
- Installing and uninstalling are audited.

## Access

- Policy kind `plugin` (baseline **closed**): nobody gets a plugin's items until
  an allow rule names them for the plugin.
- A member gets a plugin's skill when the plugin allows them and no `skill`
  rule denies that skill. A plugin's connections follow the plugin rule alone.
- Items installed by a plugin can't be edited or deleted one by one;
  uninstalling the plugin removes them all.
