import { createHash } from "node:crypto";
import { eq, or } from "drizzle-orm";
import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from "jose";
import { members } from "@offlinegpt-platform/db";
import { z } from "zod";
import { audit } from "../audit";
import type { OidcConfig } from "../config";
import { newId, randomToken, safeEqual } from "../crypto";
import type { Deps } from "../deps";
import { access, fail, type AppEnv } from "../http";
import { signIn } from "./auth";

const FLOW_COOKIE = "ogp_oidc";
const FLOW_MS = 10 * 60 * 1000;

const discoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
});
type Discovery = z.infer<typeof discoverySchema>;

const flowSchema = z.object({ state: z.string(), nonce: z.string(), verifier: z.string() });
const tokenResponseSchema = z.object({ id_token: z.string() });
const claimsSchema = z.object({
  sub: z.string(),
  nonce: z.string(),
  oid: z.string().optional(),
  email: z.string().optional(),
  preferred_username: z.string().optional(),
  upn: z.string().optional(),
  name: z.string().optional(),
});

type Provider = { discovery: Discovery; keys: JWTVerifyGetKey };

async function loadProvider(deps: Deps, oidc: OidcConfig): Promise<Provider> {
  const response = await deps.fetch(`${oidc.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`OIDC discovery failed with ${response.status}`);
  const discovery = discoverySchema.parse(await response.json());
  return { discovery, keys: createRemoteJWKSet(new URL(discovery.jwks_uri), { [customFetch]: deps.fetch }) };
}

/** Discovery is cached for the life of the app; a failed load is retried on the next sign-in. */
function providerCache(deps: Deps): (oidc: OidcConfig) => Promise<Provider> {
  let cached: Promise<Provider> | null = null;
  return (oidc) => {
    if (cached) return cached;
    const loading = loadProvider(deps, oidc).catch((error: unknown) => {
      cached = null;
      throw error;
    });
    cached = loading;
    return loading;
  };
}

function redirectUri(deps: Deps): string {
  return new URL("/auth/oidc/callback", deps.config.publicUrl).toString();
}

function emailClaim(claims: z.infer<typeof claimsSchema>): string | null {
  const value = claims.email ?? claims.preferred_username ?? claims.upn;
  return value && value.includes("@") ? value.trim().toLowerCase() : null;
}

export function registerOidcRoutes(app: Hono<AppEnv>, deps: Deps) {
  const provider = providerCache(deps);
  app.get("/auth/oidc/start", access(deps, "public"), async (c) => {
    const oidc = deps.config.oidc;
    if (!oidc) fail(404, "oidc_not_configured", "Single sign-on is not set up.");
    const { discovery } = await provider(oidc);
    const flow = { state: randomToken(16), nonce: randomToken(16), verifier: randomToken(32) };
    setCookie(c, FLOW_COOKIE, JSON.stringify(flow), {
      httpOnly: true,
      sameSite: "Lax",
      secure: deps.config.publicUrl.protocol === "https:",
      path: "/auth/oidc",
      maxAge: FLOW_MS / 1000,
    });
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: oidc.clientId,
      redirect_uri: redirectUri(deps),
      scope: "openid email profile",
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: createHash("sha256").update(flow.verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return c.redirect(url.toString(), 302);
  });

  app.get("/auth/oidc/callback", access(deps, "public"), async (c) => {
    const oidc = deps.config.oidc;
    if (!oidc) fail(404, "oidc_not_configured", "Single sign-on is not set up.");
    const flowRaw = getCookie(c, FLOW_COOKIE);
    deleteCookie(c, FLOW_COOKIE, { path: "/auth/oidc" });
    let flowValue: unknown = null;
    try {
      flowValue = flowRaw ? JSON.parse(flowRaw) : null;
    } catch {
      flowValue = null;
    }
    const flow = flowSchema.safeParse(flowValue);
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!flow.success || !state || !code || !safeEqual(state, flow.data.state)) fail(400, "invalid_oidc_state", "The sign-in attempt expired. Start again.");

    const { discovery, keys } = await provider(oidc);
    const tokenResponse = await deps.fetch(discovery.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(oidc.clientId)}:${encodeURIComponent(oidc.clientSecret)}`).toString("base64")}`,
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri(deps), code_verifier: flow.data.verifier }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokens = tokenResponseSchema.safeParse(tokenResponse.ok ? await tokenResponse.json() : null);
    if (!tokens.success) fail(401, "oidc_exchange_failed", "The identity provider did not complete sign-in.");

    const verified = await jwtVerify(tokens.data.id_token, keys, { issuer: discovery.issuer, audience: oidc.clientId, currentDate: deps.now() }).catch(() => null);
    const claims = claimsSchema.safeParse(verified?.payload);
    if (!claims.success || !safeEqual(claims.data.nonce, flow.data.nonce)) fail(401, "invalid_id_token", "The identity provider's answer could not be verified.");

    const email = emailClaim(claims.data);
    const idpIds = [claims.data.sub, claims.data.oid].filter((value): value is string => Boolean(value));
    const [byId] = await deps.db.select().from(members).where(or(...idpIds.map((id) => eq(members.externalId, id)))).limit(1);
    const [byEmail] = byId || !email ? [] : await deps.db.select().from(members).where(eq(members.email, email)).limit(1);
    let member = byId ?? byEmail;

    if (!member && oidc.jit && email) {
      const id = newId("mem");
      await deps.db.insert(members).values({ id, email, name: claims.data.name?.trim() || email, externalId: claims.data.oid ?? claims.data.sub, createdAt: deps.now() });
      await audit(deps, "system", "member.created_jit", { memberId: id, email });
      [member] = await deps.db.select().from(members).where(eq(members.id, id)).limit(1);
    }
    if (!member || !member.active) {
      await audit(deps, "system", "auth.oidc.refused", { email, reason: member ? "inactive" : "unknown" });
      fail(403, "not_provisioned", "Your account isn't set up for this workspace. Ask your IT admin for access.");
    }
    await audit(deps, member.id, "auth.oidc.signed_in");
    await signIn(deps, c, member.id);
    return c.redirect(new URL("/", deps.config.publicUrl).toString(), 302);
  });
}
