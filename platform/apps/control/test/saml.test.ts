import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { auditEvents } from "@offlinegpt-platform/db";
import { SignedXml } from "xml-crypto";
import { createHarness, json, sessionFrom, type Harness } from "./harness";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "saml", name), "utf8");
const IDP_CERT = fixture("test-only-idp.crt");
const IDP_KEY = fixture("test-only-idp.key");
const OTHER_KEY = fixture("test-only-other.key");
const ENTITY_ID = "http://control.example.test/auth/saml/metadata";
const ACS = "http://control.example.test/auth/saml/acs";

let h: Harness;
afterEach(async () => {
  await h.close();
});

async function setup(jit = false) {
  h = await createHarness({ saml: { idpCert: IDP_CERT, jit } });
  const owner = await h.setupOwner();
  const scim = String((await json(await h.call("POST", "/v1/settings/scim-token", { token: owner }))).token);
  await h.call("POST", "/scim/v2/Users", { scim, body: { userName: "ada@example.test" } });
  return { owner };
}

/** Start sign-in and return the ID of the request this service sent to the IdP. */
async function startSignIn(): Promise<string> {
  const start = await h.call("GET", "/auth/saml/start");
  expect(start.status).toBe(302);
  const location = new URL(start.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe("http://idp.example.test/sso");
  const request = inflateRawSync(Buffer.from(location.searchParams.get("SAMLRequest") ?? "", "base64")).toString("utf8");
  return /ID="([^"]+)"/.exec(request)?.[1] ?? "";
}

/** A response as an IdP sends it: an assertion signed with `key`. */
function idpResponse(options: { inResponseTo: string; nameId: string; email?: string; key?: string; audience?: string }): string {
  const now = new Date();
  const later = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  const issued = now.toISOString();
  const attributes = options.email
    ? `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${options.email}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>`
    : "";
  const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a${crypto.randomUUID().replaceAll("-", "")}" Version="2.0" IssueInstant="${issued}"><saml:Issuer>http://idp.example.test</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${options.nameId}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${options.inResponseTo}" Recipient="${ACS}" NotOnOrAfter="${later}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${issued}" NotOnOrAfter="${later}"><saml:AudienceRestriction><saml:Audience>${options.audience ?? ENTITY_ID}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${issued}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>${attributes}</saml:Assertion>`;
  const signer = new SignedXml({ privateKey: options.key ?? IDP_KEY, signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256", canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#" });
  signer.addReference({ xpath: "//*[local-name(.)='Assertion']", digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256", transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"] });
  signer.computeSignature(assertion, { location: { reference: "//*[local-name(.)='Issuer']", action: "after" } });
  const response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${crypto.randomUUID().replaceAll("-", "")}" Version="2.0" IssueInstant="${issued}" Destination="${ACS}" InResponseTo="${options.inResponseTo}"><saml:Issuer>http://idp.example.test</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signer.getSignedXml()}</samlp:Response>`;
  return Buffer.from(response).toString("base64");
}

const postToAcs = (samlResponse: string) =>
  h.app.request("/auth/saml/acs", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ SAMLResponse: samlResponse }).toString() });

test("a signed answer to our own request signs the member in", async () => {
  await setup();
  const signedIn = await postToAcs(idpResponse({ inResponseTo: await startSignIn(), nameId: "ada-idp-id", email: "Ada@Example.test" }));
  expect(signedIn.status).toBe(302);
  expect(signedIn.headers.get("location")).toBe("http://control.example.test/");
  const me = await json(await h.call("GET", "/v1/me", { token: sessionFrom(signedIn) }));
  expect(me.email).toBe("ada@example.test");
  const actions = (await h.db.select().from(auditEvents)).map((event) => event.action);
  expect(actions).toContain("auth.saml.signed_in");
});

test("wrong signer, tampering, replay and unsolicited answers are refused", async () => {
  await setup();
  expect((await postToAcs(idpResponse({ inResponseTo: await startSignIn(), nameId: "x", email: "ada@example.test", key: OTHER_KEY }))).status).toBe(401);

  const genuine = idpResponse({ inResponseTo: await startSignIn(), nameId: "x", email: "bob@example.test" });
  const tampered = Buffer.from(Buffer.from(genuine, "base64").toString("utf8").replace("bob@example.test", "ada@example.test")).toString("base64");
  expect((await postToAcs(tampered)).status).toBe(401);

  const requestId = await startSignIn();
  const once = idpResponse({ inResponseTo: requestId, nameId: "ada-idp-id", email: "ada@example.test" });
  expect((await postToAcs(once)).status).toBe(302);
  expect((await postToAcs(once)).status).toBe(401);

  expect((await postToAcs(idpResponse({ inResponseTo: "_never-sent", nameId: "x", email: "ada@example.test" }))).status).toBe(401);
  expect((await postToAcs(idpResponse({ inResponseTo: await startSignIn(), nameId: "x", email: "ada@example.test", audience: "http://someone-else.example.test" }))).status).toBe(401);
  expect((await h.db.select().from(auditEvents)).filter((event) => event.action === "auth.saml.rejected").length).toBe(5);
});

test("unknown people are refused unless just-in-time creation is on", async () => {
  await setup(false);
  expect((await postToAcs(idpResponse({ inResponseTo: await startSignIn(), nameId: "cy-id", email: "cy@example.test" }))).status).toBe(403);
  await h.close();

  await setup(true);
  const created = await postToAcs(idpResponse({ inResponseTo: await startSignIn(), nameId: "cy-id", email: "cy@example.test" }));
  expect(created.status).toBe(302);
  // Next time the IdP ID alone finds them, even if the email changed.
  const again = await postToAcs(idpResponse({ inResponseTo: await startSignIn(), nameId: "cy-id", email: "cy.new@example.test" }));
  expect((await json(await h.call("GET", "/v1/me", { token: sessionFrom(again) }))).email).toBe("cy@example.test");
});

test("metadata is served when SAML is on, and the routes are absent when it's off", async () => {
  await setup();
  expect((await h.call("GET", "/auth/sso/start")).headers.get("location")).toBe("/auth/oidc/start");
  const metadata = await h.call("GET", "/auth/saml/metadata");
  expect(metadata.status).toBe(200);
  const xml = await metadata.text();
  expect(xml).toContain(`entityID="${ENTITY_ID}"`);
  expect(xml).toContain(ACS);
  await h.close();

  h = await createHarness();
  expect((await h.call("GET", "/auth/saml/start")).status).toBe(404);
  // The console's one sign-in button prefers OIDC when both are set.
  expect((await h.call("GET", "/auth/sso/start")).headers.get("location")).toBe("/auth/oidc/start");
});
