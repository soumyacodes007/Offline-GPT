import { SAML, ValidateInResponseTo, type Profile } from "@node-saml/node-saml";
import type { Hono } from "hono";
import { audit } from "../audit";
import type { SamlConfig } from "../config";
import type { Deps } from "../deps";
import { access, fail, type AppEnv } from "../http";
import { completeSsoSignIn } from "./sso";

const EMAIL_CLAIM = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";
const NAME_CLAIM = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name";

function stringAttribute(profile: Profile, ...names: string[]): string | null {
  for (const name of names) {
    const value = profile[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function emailOf(profile: Profile): string | null {
  const email = stringAttribute(profile, "email", "mail", EMAIL_CLAIM, "urn:oid:0.9.2342.19200300.100.1.3") ?? (profile.nameID.includes("@") ? profile.nameID : null);
  return email ? email.toLowerCase() : null;
}

/** One SAML client per app, so the IDs of requests this service started are remembered between start and callback. */
function samlClient(deps: Deps, saml: SamlConfig): SAML {
  return new SAML({
    entryPoint: saml.entryPoint,
    idpCert: saml.idpCert,
    issuer: saml.entityId,
    audience: saml.entityId,
    callbackUrl: new URL("/auth/saml/acs", deps.config.publicUrl).toString(),
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    acceptedClockSkewMs: 2 * 60 * 1000,
    identifierFormat: null,
    disableRequestedAuthnContext: true,
  });
}

export function registerSamlRoutes(app: Hono<AppEnv>, deps: Deps) {
  const saml = deps.config.saml;
  const client = saml ? samlClient(deps, saml) : null;
  const configured = (): { config: SamlConfig; client: SAML } => {
    if (!saml || !client) fail(404, "saml_not_configured", "SAML sign-in is not set up.");
    return { config: saml, client };
  };

  app.get("/auth/saml/metadata", access(deps, "public"), (c) => {
    const { client: sp } = configured();
    return c.body(sp.generateServiceProviderMetadata(null, null), 200, { "content-type": "application/samlmetadata+xml" });
  });

  app.get("/auth/saml/start", access(deps, "public"), async (c) => {
    const { client: sp } = configured();
    return c.redirect(await sp.getAuthorizeUrlAsync("", undefined, {}), 302);
  });

  app.post("/auth/saml/acs", access(deps, "public"), async (c) => {
    const { config, client: sp } = configured();
    const form = await c.req.parseBody();
    const response = form.SAMLResponse;
    if (typeof response !== "string" || !response) fail(400, "invalid_saml_response", "The identity provider sent no sign-in response.");
    let profile: Profile | null = null;
    try {
      ({ profile } = await sp.validatePostResponseAsync({ SAMLResponse: response }));
    } catch (error) {
      await audit(deps, "system", "auth.saml.rejected", { reason: error instanceof Error ? error.message.slice(0, 200) : "invalid" });
    }
    if (!profile) fail(401, "invalid_saml_response", "The identity provider's answer could not be verified. Start signing in again.");
    return completeSsoSignIn(deps, c, "saml", { ids: [profile.nameID], email: emailOf(profile), name: stringAttribute(profile, "displayName", "name", NAME_CLAIM) }, config.jit);
  });
}
