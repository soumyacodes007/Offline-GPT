import { and, asc, count, eq, inArray, ne } from "drizzle-orm";
import type { Hono } from "hono";
import { members, teamMembers, teams } from "@offlinegpt-platform/db";
import { z } from "zod";
import { audit } from "../audit";
import { newId } from "../crypto";
import type { Deps } from "../deps";
import { access, fail, readJson, type AppEnv } from "../http";

const roleSchema = z.object({ role: z.enum(["owner", "admin", "member"]) });
const teamSchema = z.object({ name: z.string().trim().min(1).max(100) });
const teamMembersSchema = z.object({ memberIds: z.array(z.string().min(1)).max(10_000) });

/** A team admins can change: made in the console, not synced from the directory. */
async function manualTeam(deps: Deps, id: string) {
  const [team] = await deps.db.select().from(teams).where(eq(teams.id, id)).limit(1);
  if (!team) fail(404, "not_found", "No team with that id.");
  if (team.source !== "manual") fail(409, "directory_team", "This team comes from your directory; change it there.");
  return team;
}

export function registerPeopleRoutes(app: Hono<AppEnv>, deps: Deps) {
  app.get("/v1/members", access(deps, "admin"), async (c) => {
    const rows = await deps.db
      .select({ id: members.id, email: members.email, name: members.name, role: members.role, active: members.active, fromDirectory: members.externalId, createdAt: members.createdAt })
      .from(members)
      .orderBy(asc(members.email));
    const memberships = await deps.db.select().from(teamMembers);
    const teamsByMember = new Map<string, string[]>();
    for (const row of memberships) teamsByMember.set(row.memberId, [...(teamsByMember.get(row.memberId) ?? []), row.teamId]);
    return c.json({ members: rows.map((row) => ({ ...row, fromDirectory: row.fromDirectory !== null, teamIds: teamsByMember.get(row.id) ?? [] })) });
  });

  app.get("/v1/teams", access(deps, "admin"), async (c) => {
    const rows = await deps.db
      .select({ id: teams.id, name: teams.name, source: teams.source, members: count(teamMembers.memberId) })
      .from(teams)
      .leftJoin(teamMembers, eq(teamMembers.teamId, teams.id))
      .groupBy(teams.id)
      .orderBy(asc(teams.name));
    return c.json({ teams: rows });
  });

  app.post("/v1/teams", access(deps, "admin"), async (c) => {
    const body = await readJson(c, teamSchema);
    const [taken] = await deps.db.select({ id: teams.id }).from(teams).where(eq(teams.name, body.name)).limit(1);
    if (taken) fail(409, "name_taken", "A team with that name already exists.");
    const id = newId("team");
    await deps.db.insert(teams).values({ id, name: body.name, source: "manual", createdAt: deps.now() });
    await audit(deps, c.get("member").id, "team.created", { teamId: id, name: body.name, source: "manual" });
    return c.json({ team: { id, name: body.name, source: "manual" } }, 201);
  });

  /** Replace a manual team's members. */
  app.put("/v1/teams/:id/members", access(deps, "admin"), async (c) => {
    const team = await manualTeam(deps, c.req.param("id"));
    const body = await readJson(c, teamMembersSchema);
    const ids = [...new Set(body.memberIds)];
    const known = ids.length ? await deps.db.select({ id: members.id }).from(members).where(inArray(members.id, ids)) : [];
    if (known.length !== ids.length) fail(400, "unknown_member", "Some of those people don't exist.");
    await deps.db.transaction(async (tx) => {
      await tx.delete(teamMembers).where(eq(teamMembers.teamId, team.id));
      if (ids.length) await tx.insert(teamMembers).values(ids.map((memberId) => ({ teamId: team.id, memberId })));
    });
    await audit(deps, c.get("member").id, "team.members_set", { teamId: team.id, memberIds: ids });
    return c.json({ team: { id: team.id, memberIds: ids } });
  });

  app.delete("/v1/teams/:id", access(deps, "admin"), async (c) => {
    const team = await manualTeam(deps, c.req.param("id"));
    await deps.db.delete(teams).where(eq(teams.id, team.id));
    await audit(deps, c.get("member").id, "team.deleted", { teamId: team.id, name: team.name });
    return c.body(null, 204);
  });

  app.patch("/v1/members/:id/role", access(deps, "owner"), async (c) => {
    const body = await readJson(c, roleSchema);
    const id = c.req.param("id");
    const [member] = await deps.db.select().from(members).where(eq(members.id, id)).limit(1);
    if (!member) fail(404, "not_found", "No member with that id.");
    if (member.role === "owner" && body.role !== "owner") {
      const [others] = await deps.db.select({ value: count() }).from(members).where(and(eq(members.role, "owner"), eq(members.active, true), ne(members.id, id)));
      if ((others?.value ?? 0) === 0) fail(409, "last_owner", "Make someone else an owner first.");
    }
    await deps.db.update(members).set({ role: body.role }).where(eq(members.id, id));
    await audit(deps, c.get("member").id, "member.role_changed", { memberId: id, from: member.role, to: body.role });
    return c.json({ id, role: body.role });
  });
}
