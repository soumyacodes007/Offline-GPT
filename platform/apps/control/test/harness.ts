import type { AuditLine } from "../src/syslog";
import { openDatabase, type Database, type DatabaseHandle } from "@offlinegpt-platform/db";
import type { WorkspaceService } from "../src/workspaces/service";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createApp } from "../src/app";
import { parseConfig } from "../src/config";

export const OWNER_EMAIL = "owner@example.test";
export const SETUP_CODE = "setup-code-0123456789";
const ISSUER = "https://idp.example.test";

export type IdpUser = { sub: string; email: string; name: string };

/** A tiny OIDC provider behind a fake `fetch`: discovery, JWKS and a token endpoint that signs real ID tokens. */
async function createMockIdp(clock: () => Date) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { user: IdpUser; nonce: string }>();
  let nextUser: IdpUser | null = null;

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/.well-known/openid-configuration") {
      return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
    }
    if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
    if (url.pathname === "/token") {
      const form = new URLSearchParams(typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "");
      const grant = codes.get(form.get("code") ?? "");
      if (!grant || init?.headers === undefined) return Response.json({ error: "invalid_grant" }, { status: 400 });
      const idToken = await new SignJWT({ email: grant.user.email, name: grant.user.name, nonce: grant.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(ISSUER)
        .setAudience("control-client")
        .setSubject(grant.user.sub)
        .setIssuedAt(Math.floor(clock().getTime() / 1000))
        .setExpirationTime(Math.floor(clock().getTime() / 1000) + 300)
        .sign(privateKey);
      return Response.json({ id_token: idToken, token_type: "Bearer" });
    }
    return new Response("not found", { status: 404 });
  };

  return {
    fetch: fetchImpl,
    /** Who the IdP will say signed in next. */
    as(user: IdpUser) {
      nextUser = user;
    },
    /** Simulate the browser at the IdP: approve the authorize request and return the callback query. */
    authorize(authorizeUrl: string): string {
      const url = new URL(authorizeUrl);
      if (!nextUser) throw new Error("call idp.as(user) first");
      const code = crypto.randomUUID();
      codes.set(code, { user: nextUser, nonce: url.searchParams.get("nonce") ?? "" });
      return `code=${code}&state=${url.searchParams.get("state") ?? ""}`;
    },
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export type HarnessOptions = {
  oidcJit?: boolean;
  /** Answer some outgoing requests (e.g. to workspace containers); return null to fall through to the mock IdP. */
  route?: (input: string | URL | Request, init?: RequestInit) => Promise<Response | null>;
  workspaces?: (db: Database, now: () => Date) => WorkspaceService;
  secretsKey?: string;
  /** Turns on SAML sign-in, trusting this IdP certificate (PEM). */
  saml?: { idpCert: string; jit?: boolean };
  auditSink?: (event: AuditLine) => void;
};

export async function createHarness(options: HarnessOptions = {}) {
  const database: DatabaseHandle = openDatabase("pglite:memory");
  await database.migrate();
  let now = new Date();
  const idp = await createMockIdp(() => now);
  const config = parseConfig({
    DATABASE_URL: "pglite:memory",
    PUBLIC_URL: "http://control.example.test",
    OWNER_EMAIL,
    SETUP_CODE,
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: "control-client",
    OIDC_CLIENT_SECRET: "control-secret",
    OIDC_JIT: options.oidcJit ? "1" : "0",
    SECRETS_KEY: options.secretsKey,
    ...(options.saml ? { SAML_ENTRY_POINT: "http://idp.example.test/sso", SAML_IDP_CERT: options.saml.idpCert, SAML_JIT: options.saml.jit ? "1" : "0" } : {}),
  });
  const app = createApp({ db: database.db, config, now: () => now, fetch: async (input, init) => (await options.route?.(input, init)) ?? idp.fetch(input, init), workspaces: options.workspaces?.(database.db, () => now) ?? null, ...(options.auditSink ? { auditSink: options.auditSink } : {}) });

  const call = async (method: string, path: string, init: { token?: string; scim?: string; body?: unknown; cookie?: string } = {}): Promise<Response> =>
    app.request(path, {
      method,
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.scim ? { authorization: `Bearer ${init.scim}` } : {}),
        ...(init.cookie ? { cookie: init.cookie } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

  async function setupOwner(): Promise<string> {
    const response = await call("POST", "/setup", { body: { email: OWNER_EMAIL, name: "Owner", password: "correct horse battery", code: SETUP_CODE } });
    if (response.status !== 201) throw new Error(`setup failed: ${response.status}`);
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("token" in body) || typeof body.token !== "string") throw new Error("no token");
    return body.token;
  }

  /** Run the whole OIDC browser dance and return the response of the callback. */
  async function oidcSignIn(user: IdpUser): Promise<Response> {
    idp.as(user);
    const start = await call("GET", "/auth/oidc/start");
    const location = start.headers.get("location") ?? "";
    const flowCookie = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    return call("GET", `/auth/oidc/callback?${idp.authorize(location)}`, { cookie: flowCookie });
  }

  return {
    app,
    db: database.db,
    call,
    setupOwner,
    oidcSignIn,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    close: () => database.close(),
  };
}

export async function json(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("expected a JSON object");
  return Object.fromEntries(Object.entries(body));
}

export function sessionFrom(response: Response): string {
  const cookie = response.headers.get("set-cookie") ?? "";
  const match = /ogp_session=([^;]+)/.exec(cookie);
  if (!match?.[1]) throw new Error("no session cookie");
  return match[1];
}
