import { count, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { members, teamMembers, teams } from "@offlinegpt-platform/db";
import { z } from "zod";
import { audit } from "../audit";
import { hashPassword, newId, randomToken, safeEqual, sha256, verifyPassword } from "../crypto";
import type { Deps } from "../deps";
import { access, fail, readJson, SESSION_COOKIE, sessionToken, type AppEnv } from "../http";
import { permissionsOf } from "../permissions";
import { createSession, endSession } from "../sessions";
import { writeScimTokenHash } from "../settings";

const setupSchema = z.object({
  email: z.email(),
  name: z.string().trim().min(1).max(200),
  password: z.string().min(12, "Use at least 12 characters.").max(512),
  code: z.string().min(1),
});

const loginSchema = z.object({ email: z.email(), password: z.string().min(1).max(512) });

/** Issue a session as both a bearer token and a cookie. Exported for the OIDC callback. */
export async function signIn(deps: Deps, c: Context, memberId: string) {
  const session = await createSession(deps, memberId);
  setCookie(c, SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: deps.config.publicUrl.protocol === "https:",
    path: "/",
    expires: session.expiresAt,
  });
  return session;
}

export function registerAuthRoutes(app: Hono<AppEnv>, deps: Deps) {
  app.post("/setup", access(deps, "public"), async (c) => {
    const body = await readJson(c, setupSchema);
    const [existing] = await deps.db.select({ value: count() }).from(members);
    if ((existing?.value ?? 0) > 0) fail(409, "already_set_up", "This deployment already has an owner.");
    const email = body.email.toLowerCase();
    if (!safeEqual(body.code, deps.config.setupCode) || email !== deps.config.ownerEmail) {
      await audit(deps, "system", "setup.refused", { email });
      fail(403, "setup_refused", "The email or setup code is wrong.");
    }
    const id = newId("mem");
    await deps.db.insert(members).values({ id, email, name: body.name, role: "owner", passwordHash: await hashPassword(body.password), createdAt: deps.now() });
    await audit(deps, id, "setup.completed", { email });
    const session = await signIn(deps, c, id);
    return c.json({ token: session.token, expiresAt: session.expiresAt.toISOString() }, 201);
  });

  app.post("/auth/local", access(deps, "public"), async (c) => {
    const body = await readJson(c, loginSchema);
    const email = body.email.toLowerCase();
    const [member] = await deps.db.select().from(members).where(eq(members.email, email)).limit(1);
    const valid = member?.active === true && member.passwordHash !== null && (await verifyPassword(body.password, member.passwordHash));
    if (!member || !valid) {
      await audit(deps, "system", "auth.local.refused", { email });
      fail(401, "invalid_credentials", "The email or password is wrong.");
    }
    await audit(deps, member.id, "auth.local.signed_in");
    const session = await signIn(deps, c, member.id);
    return c.json({ token: session.token, expiresAt: session.expiresAt.toISOString() });
  });

  app.post("/auth/logout", access(deps, "member"), async (c) => {
    const token = sessionToken(c);
    if (token) await endSession(deps, token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    await audit(deps, c.get("member").id, "auth.signed_out");
    return c.body(null, 204);
  });

  app.get("/v1/me", access(deps, "member"), async (c) => {
    const member = c.get("member");
    const memberTeams = await deps.db
      .select({ id: teams.id, name: teams.name })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(eq(teamMembers.memberId, member.id));
    return c.json({ id: member.id, email: member.email, name: member.name, role: member.role, teams: memberTeams, permissions: await permissionsOf(deps, member) });
  });

  app.post("/v1/settings/scim-token", access(deps, "owner"), async (c) => {
    const token = randomToken();
    await writeScimTokenHash(deps, sha256(token));
    await audit(deps, c.get("member").id, "scim.token.rotated");
    return c.json({ token }, 201);
  });
}
