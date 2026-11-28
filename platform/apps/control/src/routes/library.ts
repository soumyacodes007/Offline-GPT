import { asc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { KIND_BASELINES, loadRules, subjectOf } from "@offlinegpt-platform/access";
import { librarySkills } from "@offlinegpt-platform/db";
import { decide, decideMany } from "@offlinegpt-platform/policy";
import { z } from "zod";
import { audit } from "../audit";
import { newId } from "../crypto";
import type { Deps } from "../deps";
import { access, fail, readJson, type AppEnv } from "../http";
import type { Member } from "../sessions";

const skillSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Use lowercase letters, numbers and `-` for the short name."),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(500),
  instructions: z.string().min(1).max(200_000),
});

export type SkillSummary = { slug: string; title: string; description: string };

/** Skills this member may use, in title order. Shared with the MCP tools. */
export async function skillsFor(deps: Deps, member: Member): Promise<SkillSummary[]> {
  const rows = await deps.db.select({ slug: librarySkills.slug, title: librarySkills.title, description: librarySkills.description }).from(librarySkills).orderBy(asc(librarySkills.title));
  const decisions = decideMany({ subject: await subjectOf(deps.db, member), kind: "skill", ids: rows.map((row) => row.slug), rules: await loadRules(deps.db, "skill"), baseline: KIND_BASELINES.skill, now: deps.now() });
  return rows.filter((row) => decisions.get(row.slug)?.allowed);
}

/** One skill's instructions if this member may use it, otherwise null. */
export async function skillFor(deps: Deps, member: Member, slug: string): Promise<{ title: string; instructions: string } | null> {
  const [row] = await deps.db.select().from(librarySkills).where(eq(librarySkills.slug, slug)).limit(1);
  if (!row) return null;
  const decision = decide({ subject: await subjectOf(deps.db, member), resource: { kind: "skill", id: slug }, rules: await loadRules(deps.db, "skill"), baseline: KIND_BASELINES.skill, now: deps.now() });
  return decision.allowed ? { title: row.title, instructions: row.instructions } : null;
}

export function registerLibraryRoutes(app: Hono<AppEnv>, deps: Deps) {
  app.post("/v1/library/skills", access(deps, "admin"), async (c) => {
    const body = await readJson(c, skillSchema);
    const actor = c.get("member").id;
    const values = { title: body.title, description: body.description, instructions: body.instructions, createdBy: actor, updatedAt: deps.now() };
    await deps.db.insert(librarySkills).values({ id: newId("skill"), slug: body.slug, ...values })
      .onConflictDoUpdate({ target: librarySkills.slug, set: values });
    await audit(deps, actor, "library.skill.published", { slug: body.slug });
    return c.json({ skill: { slug: body.slug, title: body.title, description: body.description } }, 201);
  });

  app.get("/v1/library/skills", access(deps, "admin"), async (c) => {
    const rows = await deps.db.select({ slug: librarySkills.slug, title: librarySkills.title, description: librarySkills.description, updatedAt: librarySkills.updatedAt }).from(librarySkills).orderBy(asc(librarySkills.title));
    return c.json({ skills: rows });
  });

  app.delete("/v1/library/skills/:slug", access(deps, "admin"), async (c) => {
    const slug = c.req.param("slug");
    const deleted = await deps.db.delete(librarySkills).where(eq(librarySkills.slug, slug)).returning({ slug: librarySkills.slug });
    if (!deleted.length) fail(404, "not_found", "No skill with that name.");
    await audit(deps, c.get("member").id, "library.skill.deleted", { slug });
    return c.body(null, 204);
  });

  app.get("/v1/me/library", access(deps, "member"), async (c) => c.json({ skills: await skillsFor(deps, c.get("member")) }));
}
