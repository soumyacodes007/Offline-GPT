import { and, count, eq, inArray, ne } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { members, teamMembers, teams } from "@offlinegpt-platform/db";
import { z } from "zod";
import { audit } from "../audit";
import { newId } from "../crypto";
import type { Deps } from "../deps";
import { access, type AppEnv } from "../http";
import { endMemberSessions, type Member } from "../sessions";

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

type Team = typeof teams.$inferSelect;

function scimError(c: Context, status: 400 | 404 | 409, detail: string, scimType?: string) {
  return c.json({ schemas: [ERROR_SCHEMA], status: String(status), detail, ...(scimType ? { scimType } : {}) }, status);
}

/** IdPs send booleans as `true`, `"True"` or `"false"`. */
const scimBoolean = z.union([z.boolean(), z.enum(["true", "false", "True", "False"]).transform((value) => value.toLowerCase() === "true")]);

const userSchema = z.object({
  userName: z.string().trim().min(1),
  externalId: z.string().trim().min(1).optional(),
  displayName: z.string().trim().optional(),
  name: z.object({ formatted: z.string().optional(), givenName: z.string().optional(), familyName: z.string().optional() }).optional(),
  emails: z.array(z.object({ value: z.string(), primary: scimBoolean.optional() })).optional(),
  active: scimBoolean.optional(),
});

const patchSchema = z.object({
  Operations: z.array(z.object({ op: z.string().transform((op) => op.toLowerCase()), path: z.string().optional(), value: z.unknown().optional() })).min(1),
});

const groupSchema = z.object({
  displayName: z.string().trim().min(1),
  externalId: z.string().trim().min(1).optional(),
  members: z.array(z.object({ value: z.string() })).optional(),
});

function displayNameOf(user: z.infer<typeof userSchema>): string {
  const formatted = user.name?.formatted?.trim() || [user.name?.givenName, user.name?.familyName].filter(Boolean).join(" ").trim();
  return user.displayName || formatted || user.userName;
}

function emailOf(user: z.infer<typeof userSchema>): string {
  const primary = user.emails?.find((email) => email.primary) ?? user.emails?.[0];
  return (primary?.value ?? user.userName).trim().toLowerCase();
}

function userResource(deps: Deps, member: Member) {
  return {
    schemas: [USER_SCHEMA],
    id: member.id,
    ...(member.externalId ? { externalId: member.externalId } : {}),
    userName: member.email,
    displayName: member.name,
    name: { formatted: member.name },
    emails: [{ value: member.email, primary: true }],
    active: member.active,
    meta: { resourceType: "User", location: new URL(`/scim/v2/Users/${member.id}`, deps.config.publicUrl).toString() },
  };
}

async function groupResource(deps: Deps, team: Team) {
  const rows = await deps.db.select({ value: teamMembers.memberId }).from(teamMembers).where(eq(teamMembers.teamId, team.id));
  return {
    schemas: [GROUP_SCHEMA],
    id: team.id,
    ...(team.externalId ? { externalId: team.externalId } : {}),
    displayName: team.name,
    members: rows,
    meta: { resourceType: "Group", location: new URL(`/scim/v2/Groups/${team.id}`, deps.config.publicUrl).toString() },
  };
}

function listResponse(resources: unknown[]) {
  return { schemas: [LIST_SCHEMA], totalResults: resources.length, startIndex: 1, itemsPerPage: resources.length, Resources: resources };
}

/** Supports the one filter IdPs use for lookups: `<attribute> eq "<value>"`. */
function parseEqFilter(filter: string | undefined, attribute: string): string | null | undefined {
  if (!filter) return undefined;
  const match = new RegExp(`^\\s*${attribute}\\s+eq\\s+"((?:[^"\\\\]|\\\\.)*)"\\s*$`, "i").exec(filter);
  return match?.[1] ? match[1].replace(/\\(.)/g, "$1") : null;
}

async function isLastActiveOwner(deps: Deps, member: Member): Promise<boolean> {
  if (member.role !== "owner" || !member.active) return false;
  const [others] = await deps.db.select({ value: count() }).from(members).where(and(eq(members.role, "owner"), eq(members.active, true), ne(members.id, member.id)));
  return (others?.value ?? 0) === 0;
}

async function setActive(deps: Deps, member: Member, active: boolean): Promise<void> {
  if (member.active === active) return;
  await deps.db.update(members).set({ active, deactivatedAt: active ? null : deps.now() }).where(eq(members.id, member.id));
  if (!active) {
    await endMemberSessions(deps, member.id);
    await deps.workspaces?.stop(member.id);
  }
  await audit(deps, "scim", active ? "member.reactivated" : "member.deactivated", { memberId: member.id });
}

async function findMember(deps: Deps, id: string): Promise<Member | undefined> {
  const [member] = await deps.db.select().from(members).where(eq(members.id, id)).limit(1);
  return member;
}

async function findTeam(deps: Deps, id: string): Promise<Team | undefined> {
  const [team] = await deps.db.select().from(teams).where(eq(teams.id, id)).limit(1);
  return team;
}

async function addTeamMembers(deps: Deps, teamId: string, memberIds: string[]): Promise<void> {
  if (!memberIds.length) return;
  const known = await deps.db.select({ id: members.id }).from(members).where(inArray(members.id, memberIds));
  if (!known.length) return;
  await deps.db.insert(teamMembers).values(known.map(({ id }) => ({ teamId, memberId: id }))).onConflictDoNothing();
}

/** `members[value eq "id"]` → `id`. */
function memberFromPath(path: string): string | null {
  return /^members\[value eq "([^"]+)"\]$/i.exec(path.trim())?.[1] ?? null;
}

function memberValues(value: unknown): string[] {
  const parsed = z.array(z.object({ value: z.string() })).safeParse(value);
  return parsed.success ? parsed.data.map((entry) => entry.value) : [];
}

export function registerScimRoutes(app: Hono<AppEnv>, deps: Deps) {
  const scim = access(deps, "scim");

  app.get("/scim/v2/Users", scim, async (c) => {
    const userName = parseEqFilter(c.req.query("filter"), "userName");
    if (userName === null) return scimError(c, 400, "Only `userName eq \"...\"` filters are supported.", "invalidFilter");
    const rows = userName === undefined
      ? await deps.db.select().from(members).orderBy(members.createdAt)
      : await deps.db.select().from(members).where(eq(members.email, userName.toLowerCase()));
    return c.json(listResponse(rows.map((member) => userResource(deps, member))));
  });

  app.post("/scim/v2/Users", scim, async (c) => {
    const parsed = userSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return scimError(c, 400, parsed.error.issues[0]?.message ?? "Invalid user.", "invalidValue");
    const email = emailOf(parsed.data);
    const [existing] = await deps.db.select({ id: members.id }).from(members).where(eq(members.email, email)).limit(1);
    if (existing) return scimError(c, 409, "A user with this userName already exists.", "uniqueness");
    const id = newId("mem");
    const active = parsed.data.active ?? true;
    await deps.db.insert(members).values({ id, email, name: displayNameOf(parsed.data), externalId: parsed.data.externalId ?? null, active, createdAt: deps.now(), deactivatedAt: active ? null : deps.now() });
    await audit(deps, "scim", "member.created", { memberId: id, email });
    const member = await findMember(deps, id);
    return member ? c.json(userResource(deps, member), 201) : scimError(c, 404, "User not found.");
  });

  app.get("/scim/v2/Users/:id", scim, async (c) => {
    const member = await findMember(deps, c.req.param("id"));
    return member ? c.json(userResource(deps, member)) : scimError(c, 404, "User not found.");
  });

  app.put("/scim/v2/Users/:id", scim, async (c) => {
    const member = await findMember(deps, c.req.param("id"));
    if (!member) return scimError(c, 404, "User not found.");
    const parsed = userSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return scimError(c, 400, parsed.error.issues[0]?.message ?? "Invalid user.", "invalidValue");
    const active = parsed.data.active ?? true;
    if (!active && (await isLastActiveOwner(deps, member))) return scimError(c, 409, "The last active owner cannot be deactivated.", "mutability");
    await deps.db.update(members).set({ email: emailOf(parsed.data), name: displayNameOf(parsed.data), externalId: parsed.data.externalId ?? member.externalId }).where(eq(members.id, member.id));
    await setActive(deps, member, active);
    await audit(deps, "scim", "member.replaced", { memberId: member.id });
    const updated = await findMember(deps, member.id);
    return updated ? c.json(userResource(deps, updated)) : scimError(c, 404, "User not found.");
  });

  app.patch("/scim/v2/Users/:id", scim, async (c) => {
    const member = await findMember(deps, c.req.param("id"));
    if (!member) return scimError(c, 404, "User not found.");
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return scimError(c, 400, "Invalid PATCH request.", "invalidSyntax");
    let active = member.active;
    let name = member.name;
    for (const operation of parsed.data.Operations) {
      if (operation.op !== "replace" && operation.op !== "add") continue;
      // Either `{ path: "active", value }` or a value object without a path.
      const fields = operation.path ? { [operation.path]: operation.value } : z.record(z.string(), z.unknown()).catch({}).parse(operation.value);
      for (const [path, value] of Object.entries(fields)) {
        if (path === "active") {
          const parsedActive = scimBoolean.safeParse(value);
          if (!parsedActive.success) return scimError(c, 400, "`active` must be a boolean.", "invalidValue");
          active = parsedActive.data;
        } else if (path === "displayName" || path === "name.formatted") {
          const text = z.string().trim().min(1).safeParse(value);
          if (text.success) name = text.data;
        }
      }
    }
    if (!active && (await isLastActiveOwner(deps, member))) return scimError(c, 409, "The last active owner cannot be deactivated.", "mutability");
    if (name !== member.name) await deps.db.update(members).set({ name }).where(eq(members.id, member.id));
    await setActive(deps, member, active);
    const updated = await findMember(deps, member.id);
    return updated ? c.json(userResource(deps, updated)) : scimError(c, 404, "User not found.");
  });

  app.delete("/scim/v2/Users/:id", scim, async (c) => {
    const member = await findMember(deps, c.req.param("id"));
    if (!member) return scimError(c, 404, "User not found.");
    if (await isLastActiveOwner(deps, member)) return scimError(c, 409, "The last active owner cannot be deactivated.", "mutability");
    // The record stays for audit; deletion means "can never sign in again".
    await setActive(deps, member, false);
    return c.body(null, 204);
  });

  app.get("/scim/v2/Groups", scim, async (c) => {
    const displayName = parseEqFilter(c.req.query("filter"), "displayName");
    if (displayName === null) return scimError(c, 400, "Only `displayName eq \"...\"` filters are supported.", "invalidFilter");
    const rows = displayName === undefined ? await deps.db.select().from(teams).orderBy(teams.createdAt) : await deps.db.select().from(teams).where(eq(teams.name, displayName));
    return c.json(listResponse(await Promise.all(rows.map((team) => groupResource(deps, team)))));
  });

  app.post("/scim/v2/Groups", scim, async (c) => {
    const parsed = groupSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return scimError(c, 400, parsed.error.issues[0]?.message ?? "Invalid group.", "invalidValue");
    const [existing] = await deps.db.select({ id: teams.id }).from(teams).where(eq(teams.name, parsed.data.displayName)).limit(1);
    if (existing) return scimError(c, 409, "A group with this displayName already exists.", "uniqueness");
    const id = newId("team");
    await deps.db.insert(teams).values({ id, name: parsed.data.displayName, externalId: parsed.data.externalId ?? null, createdAt: deps.now() });
    await addTeamMembers(deps, id, (parsed.data.members ?? []).map((entry) => entry.value));
    await audit(deps, "scim", "team.created", { teamId: id, name: parsed.data.displayName });
    const team = await findTeam(deps, id);
    return team ? c.json(await groupResource(deps, team), 201) : scimError(c, 404, "Group not found.");
  });

  app.get("/scim/v2/Groups/:id", scim, async (c) => {
    const team = await findTeam(deps, c.req.param("id"));
    return team ? c.json(await groupResource(deps, team)) : scimError(c, 404, "Group not found.");
  });

  app.patch("/scim/v2/Groups/:id", scim, async (c) => {
    const team = await findTeam(deps, c.req.param("id"));
    if (!team) return scimError(c, 404, "Group not found.");
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return scimError(c, 400, "Invalid PATCH request.", "invalidSyntax");
    for (const operation of parsed.data.Operations) {
      const path = operation.path?.trim() ?? "";
      const pathMember = memberFromPath(path);
      if (operation.op === "remove" && pathMember) {
        await deps.db.delete(teamMembers).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.memberId, pathMember)));
      } else if (operation.op === "remove" && path.toLowerCase() === "members") {
        const ids = memberValues(operation.value);
        const condition = ids.length ? and(eq(teamMembers.teamId, team.id), inArray(teamMembers.memberId, ids)) : eq(teamMembers.teamId, team.id);
        await deps.db.delete(teamMembers).where(condition);
      } else if (operation.op === "add" && path.toLowerCase() === "members") {
        await addTeamMembers(deps, team.id, memberValues(operation.value));
      } else if (operation.op === "replace" && path.toLowerCase() === "members") {
        await deps.db.delete(teamMembers).where(eq(teamMembers.teamId, team.id));
        await addTeamMembers(deps, team.id, memberValues(operation.value));
      } else if (operation.op === "replace") {
        const fields = path ? { [path]: operation.value } : z.record(z.string(), z.unknown()).catch({}).parse(operation.value);
        const displayName = z.string().trim().min(1).safeParse(fields.displayName);
        if (displayName.success) await deps.db.update(teams).set({ name: displayName.data }).where(eq(teams.id, team.id));
      }
    }
    await audit(deps, "scim", "team.updated", { teamId: team.id });
    const updated = await findTeam(deps, team.id);
    return updated ? c.json(await groupResource(deps, updated)) : scimError(c, 404, "Group not found.");
  });

  app.delete("/scim/v2/Groups/:id", scim, async (c) => {
    const team = await findTeam(deps, c.req.param("id"));
    if (!team) return scimError(c, 404, "Group not found.");
    await deps.db.delete(teams).where(eq(teams.id, team.id));
    await audit(deps, "scim", "team.deleted", { teamId: team.id });
    return c.body(null, 204);
  });
}
