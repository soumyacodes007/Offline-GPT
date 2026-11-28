import { and, asc, eq, inArray, isNull, or, ne } from "drizzle-orm";
import type { Hono } from "hono";
import { libraryPlugins, librarySkills, mcpConnections } from "@offlinegpt-platform/db";
import { z } from "zod";
import { audit } from "../audit";
import { encryptSecret, newId } from "../crypto";
import type { Deps } from "../deps";
import { access, fail, readJson, type AppEnv } from "../http";
import { MAX_PLUGIN_BYTES, parsePlugin, type ParsedPlugin } from "../plugins/parse";

const installSchema = z.object({ base64: z.string().min(1).max(Math.ceil((MAX_PLUGIN_BYTES * 4) / 3) + 4) });

export function registerPluginRoutes(app: Hono<AppEnv>, deps: Deps) {
  app.post("/v1/library/plugins", access(deps, "admin"), async (c) => {
    const body = await readJson(c, installSchema);
    let plugin: ParsedPlugin;
    try {
      plugin = parsePlugin(new Uint8Array(Buffer.from(body.base64, "base64")));
    } catch (error) {
      fail(400, "invalid_plugin", error instanceof Error ? error.message : "That plugin couldn't be read.");
    }
    const skipped = [...plugin.skipped];
    const secretsKey = deps.config.secretsKey;
    const connections = plugin.connections.map((connection) => {
      if (connection.header && !secretsKey) {
        skipped.push(`MCP server "${connection.name}": its credential wasn't stored because SECRETS_KEY isn't set`);
        return { ...connection, header: null, needsCredential: true };
      }
      return connection;
    });
    const skillSlugs = plugin.skills.map((skill) => `${plugin.slug}-${skill.name}`);
    const connectionSlugs = connections.map((connection) => `${plugin.slug}-${connection.name}`);

    // Names another plugin or an admin already uses can't be taken over.
    const clashes = [
      ...(skillSlugs.length ? await deps.db.select({ slug: librarySkills.slug }).from(librarySkills).where(and(inArray(librarySkills.slug, skillSlugs), or(isNull(librarySkills.pluginSlug), ne(librarySkills.pluginSlug, plugin.slug)))) : []),
      ...(connectionSlugs.length ? await deps.db.select({ slug: mcpConnections.slug }).from(mcpConnections).where(and(inArray(mcpConnections.slug, connectionSlugs), or(isNull(mcpConnections.pluginSlug), ne(mcpConnections.pluginSlug, plugin.slug)))) : []),
    ];
    if (clashes.length) fail(409, "name_taken", `These names are already used in the library: ${clashes.map((clash) => clash.slug).join(", ")}.`);

    const actor = c.get("member").id;
    const at = deps.now();
    await deps.db.transaction(async (tx) => {
      const values = { title: plugin.title, description: plugin.description, version: plugin.version, createdBy: actor, updatedAt: at };
      await tx.insert(libraryPlugins).values({ id: newId("plugin"), slug: plugin.slug, ...values }).onConflictDoUpdate({ target: libraryPlugins.slug, set: values });
      await tx.delete(librarySkills).where(eq(librarySkills.pluginSlug, plugin.slug));
      // Keep credentials an admin already set on connections that are still in the plugin.
      const kept = await tx.select({ slug: mcpConnections.slug, headerName: mcpConnections.headerName, headerValueSealed: mcpConnections.headerValueSealed }).from(mcpConnections).where(eq(mcpConnections.pluginSlug, plugin.slug));
      await tx.delete(mcpConnections).where(eq(mcpConnections.pluginSlug, plugin.slug));
      if (plugin.skills.length) {
        await tx.insert(librarySkills).values(plugin.skills.map((skill) => ({ id: newId("skill"), slug: `${plugin.slug}-${skill.name}`, title: skill.title, description: skill.description, instructions: skill.instructions, pluginSlug: plugin.slug, createdBy: actor, updatedAt: at })));
      }
      if (connections.length) {
        await tx.insert(mcpConnections).values(connections.map((connection) => {
          const slug = `${plugin.slug}-${connection.name}`;
          const previous = kept.find((row) => row.slug === slug);
          const header = connection.header && secretsKey
            ? { headerName: connection.header.name, headerValueSealed: encryptSecret(secretsKey, connection.header.value) }
            : { headerName: previous?.headerName ?? null, headerValueSealed: previous?.headerValueSealed ?? null };
          return { id: newId("conn"), slug, title: `${plugin.title}: ${connection.name}`, description: `From the ${plugin.title} plugin.`, url: connection.url, ...header, pluginSlug: plugin.slug, createdBy: actor, updatedAt: at };
        }));
      }
    });
    await audit(deps, actor, "plugin.installed", { slug: plugin.slug, version: plugin.version, skills: skillSlugs, connections: connectionSlugs });
    return c.json({
      plugin: { slug: plugin.slug, title: plugin.title, version: plugin.version },
      skills: skillSlugs,
      connections: connections.map((connection) => ({ slug: `${plugin.slug}-${connection.name}`, needsCredential: connection.needsCredential })),
      skipped,
    }, 201);
  });

  app.get("/v1/library/plugins", access(deps, "admin"), async (c) => {
    const plugins = await deps.db.select().from(libraryPlugins).orderBy(asc(libraryPlugins.title));
    const skills = await deps.db.select({ slug: librarySkills.slug, plugin: librarySkills.pluginSlug }).from(librarySkills);
    const connections = await deps.db.select({ slug: mcpConnections.slug, plugin: mcpConnections.pluginSlug }).from(mcpConnections);
    return c.json({
      plugins: plugins.map((plugin) => ({
        slug: plugin.slug,
        title: plugin.title,
        description: plugin.description,
        version: plugin.version,
        updatedAt: plugin.updatedAt,
        skills: skills.filter((skill) => skill.plugin === plugin.slug).map((skill) => skill.slug),
        connections: connections.filter((connection) => connection.plugin === plugin.slug).map((connection) => connection.slug),
      })),
    });
  });

  app.delete("/v1/library/plugins/:slug", access(deps, "admin"), async (c) => {
    const slug = c.req.param("slug");
    // Its skills and connections go with it (foreign keys cascade).
    const deleted = await deps.db.delete(libraryPlugins).where(eq(libraryPlugins.slug, slug)).returning({ slug: libraryPlugins.slug });
    if (!deleted.length) fail(404, "not_found", "No plugin with that name.");
    await audit(deps, c.get("member").id, "plugin.uninstalled", { slug });
    return c.body(null, 204);
  });
}
