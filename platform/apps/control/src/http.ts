import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import { safeEqual, sha256 } from "./crypto";
import type { Deps } from "./deps";
import { permissionsOf, type Permission } from "./permissions";
import { resolveInferenceKey, resolveSession, type Member } from "./sessions";
import { readScimTokenHash } from "./settings";

export const SESSION_COOKIE = "ogp_session";

export type AppEnv = { Variables: { member: Member } };

/**
 * Who may call a route. `public`: anyone. `member`: any signed-in active
 * member. `admin`: owners and admins. `owner`: owners only. `scim`: the IdP's
 * SCIM token. `agent`: a member's inference key, used by their workspace.
 * `{ permission }`: owners, admins, and members whose custom role grants it.
 */
export type Access = "public" | "member" | "admin" | "owner" | "scim" | "agent" | { permission: Permission };

/** Marks a middleware as the route's access declaration, so a test can prove every route has one. */
export const ACCESS_TAG = Symbol("access");
export type TaggedMiddleware = MiddlewareHandler<AppEnv> & { [ACCESS_TAG]: Access };

export function bearerToken(c: Context): string | null {
  const header = c.req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim() || null;
  return null;
}

export function sessionToken(c: Context): string | null {
  return bearerToken(c) ?? getCookie(c, SESSION_COOKIE) ?? null;
}

export function fail(status: 400 | 401 | 403 | 404 | 409, code: string, message: string): never {
  throw new HTTPException(status, { res: Response.json({ error: code, message }, { status }) });
}

const roleRank: Record<Member["role"], number> = { member: 0, admin: 1, owner: 2 };

export function access(deps: Deps, level: Access): TaggedMiddleware {
  const middleware: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (level === "public") return next();
    if (level === "scim") {
      const stored = await readScimTokenHash(deps);
      const token = bearerToken(c);
      if (!stored || !token || !safeEqual(sha256(token), stored)) {
        return c.json({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "401", detail: "Invalid SCIM token." }, 401);
      }
      return next();
    }
    if (level === "agent") {
      const key = bearerToken(c);
      const agent = key ? await resolveInferenceKey(deps, key) : null;
      if (!agent) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Invalid workspace key." } }, 401);
      c.set("member", agent);
      return next();
    }
    const token = sessionToken(c);
    const member = token ? await resolveSession(deps, token) : null;
    if (!member) fail(401, "unauthenticated", "Sign in first.");
    if (typeof level === "object") {
      if (!(await permissionsOf(deps, member)).includes(level.permission)) fail(403, "forbidden", "You don't have permission to do this.");
      c.set("member", member);
      return next();
    }
    const needed = level === "owner" ? roleRank.owner : level === "admin" ? roleRank.admin : roleRank.member;
    if (roleRank[member.role] < needed) fail(403, "forbidden", "You don't have permission to do this.");
    c.set("member", member);
    return next();
  };
  return Object.assign(middleware, { [ACCESS_TAG]: level });
}

/** Parse a JSON body with a schema; a bad body is a 400 with the first problem. */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    fail(400, "invalid_json", "The request body must be JSON.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) fail(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.");
  return parsed.data;
}
