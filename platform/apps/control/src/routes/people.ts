import { and, asc, count, eq, ne } from "drizzle-orm";
import type { Hono } from "hono";
import { members, teamMembers, teams } from "@offlinegpt-platform/db";
import { z } from "zod";
import { audit } from "../audit";
import type { Deps } from "../deps";
import { access, fail, readJson, type AppEnv } from "../http";

const roleSchema = z.object({ role: z.enum(["owner", "admin", "member"]) });

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
      .select({ id: teams.id, name: teams.name, members: count(teamMembers.memberId) })
      .from(teams)
      .leftJoin(teamMembers, eq(teamMembers.teamId, teams.id))
      .groupBy(teams.id)
      .orderBy(asc(teams.name));
    return c.json({ teams: rows });
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
