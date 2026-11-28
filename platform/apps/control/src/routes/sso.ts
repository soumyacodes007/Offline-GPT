import { eq, or } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { members } from "@offlinegpt-platform/db";
import { audit } from "../audit";
import { newId } from "../crypto";
import type { Deps } from "../deps";
import { access, fail, type AppEnv } from "../http";
import { signIn } from "./auth";

export type SsoIdentity = {
  /** Identity provider IDs for this person, most specific first; the first is stored for new members. */
  ids: string[];
  email: string | null;
  name: string | null;
};

/**
 * The one rule for every single sign-on method: match by identity provider ID,
 * else by email; create the member only when just-in-time creation is on;
 * refuse unknown and inactive people. Signs the member in on success.
 */
export async function completeSsoSignIn(deps: Deps, c: Context<AppEnv>, method: "oidc" | "saml", identity: SsoIdentity, jit: boolean): Promise<Response> {
  const ids = identity.ids.filter(Boolean);
  const [byId] = ids.length ? await deps.db.select().from(members).where(or(...ids.map((id) => eq(members.externalId, id)))).limit(1) : [];
  const [byEmail] = byId || !identity.email ? [] : await deps.db.select().from(members).where(eq(members.email, identity.email)).limit(1);
  let member = byId ?? byEmail;

  const [firstId] = ids;
  if (!member && jit && identity.email && firstId) {
    const id = newId("mem");
    await deps.db.insert(members).values({ id, email: identity.email, name: identity.name?.trim() || identity.email, externalId: firstId, createdAt: deps.now() });
    await audit(deps, "system", "member.created_jit", { memberId: id, email: identity.email, method });
    [member] = await deps.db.select().from(members).where(eq(members.id, id)).limit(1);
  }
  if (!member || !member.active) {
    await audit(deps, "system", `auth.${method}.refused`, { email: identity.email, reason: member ? "inactive" : "unknown" });
    fail(403, "not_provisioned", "Your account isn't set up for this workspace. Ask your IT admin for access.");
  }
  await audit(deps, member.id, `auth.${method}.signed_in`);
  await signIn(deps, c, member.id);
  return c.redirect(new URL("/", deps.config.publicUrl).toString(), 302);
}

/** One sign-in button for the console, whichever single sign-on method this deployment uses. */
export function registerSsoRoutes(app: Hono<AppEnv>, deps: Deps) {
  app.get("/auth/sso/start", access(deps, "public"), (c) => {
    if (deps.config.oidc) return c.redirect("/auth/oidc/start", 302);
    if (deps.config.saml) return c.redirect("/auth/saml/start", 302);
    fail(404, "sso_not_configured", "Single sign-on is not set up. Ask your IT admin.");
  });
}
