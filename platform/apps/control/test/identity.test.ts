import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ACCESS_TAG } from "../src/http";
import { createHarness, json, OWNER_EMAIL, SETUP_CODE, sessionFrom, type Harness } from "./harness";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

async function scimToken(owner: string): Promise<string> {
  const response = await h.call("POST", "/v1/settings/scim-token", { token: owner });
  expect(response.status).toBe(201);
  const body = await json(response);
  if (typeof body.token !== "string") throw new Error("no scim token");
  return body.token;
}

async function scimUser(scim: string, email: string, name = "Person"): Promise<string> {
  const response = await h.call("POST", "/scim/v2/Users", { scim, body: { userName: email, name: { formatted: name }, emails: [{ value: email, primary: true }], active: true } });
  expect(response.status).toBe(201);
  const body = await json(response);
  if (typeof body.id !== "string") throw new Error("no user id");
  return body.id;
}

test("every route declares who may call it", () => {
  const byRoute = new Map<string, boolean>();
  for (const route of h.app.routes) {
    const key = `${route.method} ${route.path}`;
    byRoute.set(key, (byRoute.get(key) ?? false) || ACCESS_TAG in route.handler);
  }
  const undeclared = [...byRoute].filter(([, declared]) => !declared).map(([key]) => key);
  expect(undeclared).toEqual([]);
  expect(byRoute.size).toBeGreaterThan(15);
});

describe("first owner", () => {
  test("setup works once, with the right email and code only", async () => {
    const wrongCode = await h.call("POST", "/setup", { body: { email: OWNER_EMAIL, name: "O", password: "correct horse battery", code: "nope" } });
    expect(wrongCode.status).toBe(403);
    const wrongEmail = await h.call("POST", "/setup", { body: { email: "someone@example.test", name: "O", password: "correct horse battery", code: SETUP_CODE } });
    expect(wrongEmail.status).toBe(403);
    const owner = await h.setupOwner();
    const me = await json(await h.call("GET", "/v1/me", { token: owner }));
    expect(me).toMatchObject({ email: OWNER_EMAIL, role: "owner" });
    const again = await h.call("POST", "/setup", { body: { email: OWNER_EMAIL, name: "O", password: "correct horse battery", code: SETUP_CODE } });
    expect(again.status).toBe(409);
  });

  test("the owner can sign in and out with the break-glass password", async () => {
    await h.setupOwner();
    expect((await h.call("POST", "/auth/local", { body: { email: OWNER_EMAIL, password: "wrong password!!" } })).status).toBe(401);
    const signedIn = await json(await h.call("POST", "/auth/local", { body: { email: "OWNER@example.test", password: "correct horse battery" } }));
    if (typeof signedIn.token !== "string") throw new Error("no token");
    expect((await h.call("POST", "/auth/logout", { token: signedIn.token })).status).toBe(204);
    expect((await h.call("GET", "/v1/me", { token: signedIn.token })).status).toBe(401);
  });

  test("sessions expire", async () => {
    const owner = await h.setupOwner();
    h.advance(12 * 60 * 60 * 1000 + 1);
    expect((await h.call("GET", "/v1/me", { token: owner })).status).toBe(401);
  });
});

describe("SCIM and OIDC", () => {
  test("a wrong or missing SCIM token is refused", async () => {
    const owner = await h.setupOwner();
    await scimToken(owner);
    expect((await h.call("GET", "/scim/v2/Users", { scim: "not-the-token" })).status).toBe(401);
    expect((await h.call("GET", "/scim/v2/Users")).status).toBe(401);
    expect((await h.call("POST", "/v1/settings/scim-token")).status).toBe(401);
  });

  test("a SCIM-created user signs in with OIDC; a user not in SCIM is refused", async () => {
    const owner = await h.setupOwner();
    const scim = await scimToken(owner);
    await scimUser(scim, "Ada@Example.test", "Ada");

    const ok = await h.oidcSignIn({ sub: "idp-ada", email: "ada@example.test", name: "Ada" });
    expect(ok.status).toBe(302);
    const me = await json(await h.call("GET", "/v1/me", { token: sessionFrom(ok) }));
    expect(me).toMatchObject({ email: "ada@example.test", role: "member" });

    const stranger = await h.oidcSignIn({ sub: "idp-eve", email: "eve@example.test", name: "Eve" });
    expect(stranger.status).toBe(403);
  });

  test("a forged state is refused", async () => {
    const start = await h.call("GET", "/auth/oidc/start");
    const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect((await h.call("GET", "/auth/oidc/callback?code=x&state=forged", { cookie })).status).toBe(400);
  });

  test("SCIM deactivation ends a live session and blocks the next sign-in", async () => {
    const owner = await h.setupOwner();
    const scim = await scimToken(owner);
    const id = await scimUser(scim, "bob@example.test", "Bob");
    const signedIn = await h.oidcSignIn({ sub: "idp-bob", email: "bob@example.test", name: "Bob" });
    const session = sessionFrom(signedIn);
    expect((await h.call("GET", "/v1/me", { token: session })).status).toBe(200);

    // Entra sends booleans as strings.
    const patched = await h.call("PATCH", `/scim/v2/Users/${id}`, { scim, body: { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "Replace", path: "active", value: "False" }] } });
    expect(patched.status).toBe(200);
    expect(await json(patched)).toMatchObject({ active: false });
    expect((await h.call("GET", "/v1/me", { token: session })).status).toBe(401);
    expect((await h.oidcSignIn({ sub: "idp-bob", email: "bob@example.test", name: "Bob" })).status).toBe(403);
  });

  test("SCIM lookups, duplicates and groups behave like an IdP expects", async () => {
    const owner = await h.setupOwner();
    const scim = await scimToken(owner);
    const ada = await scimUser(scim, "ada@example.test");
    const duplicate = await h.call("POST", "/scim/v2/Users", { scim, body: { userName: "ADA@example.test" } });
    expect(duplicate.status).toBe(409);
    const found = await json(await h.call("GET", `/scim/v2/Users?filter=${encodeURIComponent('userName eq "ada@example.test"')}`, { scim }));
    expect(found.totalResults).toBe(1);

    const group = await h.call("POST", "/scim/v2/Groups", { scim, body: { displayName: "Legal", members: [{ value: ada }] } });
    expect(group.status).toBe(201);
    const groupBody = await json(group);
    const groupId = String(groupBody.id);
    const me = await json(await h.oidcSignIn({ sub: "s", email: "ada@example.test", name: "Ada" }).then((response) => h.call("GET", "/v1/me", { token: sessionFrom(response) })));
    expect(me.teams).toEqual([{ id: groupId, name: "Legal" }]);

    const removed = await h.call("PATCH", `/scim/v2/Groups/${groupId}`, { scim, body: { Operations: [{ op: "remove", path: `members[value eq "${ada}"]` }] } });
    expect(await json(removed)).toMatchObject({ members: [] });
  });

  test("the last active owner cannot be deactivated through SCIM", async () => {
    const owner = await h.setupOwner();
    const scim = await scimToken(owner);
    const me = await json(await h.call("GET", "/v1/me", { token: owner }));
    const response = await h.call("DELETE", `/scim/v2/Users/${String(me.id)}`, { scim });
    expect(response.status).toBe(409);
    expect((await h.call("GET", "/v1/me", { token: owner })).status).toBe(200);
  });
});

describe("people", () => {
  test("owners change roles, but the last owner cannot step down", async () => {
    const owner = await h.setupOwner();
    const scim = await scimToken(owner);
    const ada = await scimUser(scim, "ada@example.test", "Ada");
    const list = await json(await h.call("GET", "/v1/members", { token: owner }));
    expect((list.members as Array<{ email: string }>).map((member) => member.email)).toEqual(["ada@example.test", OWNER_EMAIL]);
    const me = String((await json(await h.call("GET", "/v1/me", { token: owner }))).id);
    expect((await h.call("PATCH", `/v1/members/${me}/role`, { token: owner, body: { role: "member" } })).status).toBe(409);
    expect((await h.call("PATCH", `/v1/members/${ada}/role`, { token: owner, body: { role: "admin" } })).status).toBe(200);
    const adaSession = sessionFrom(await h.oidcSignIn({ sub: "a", email: "ada@example.test", name: "Ada" }));
    expect((await h.call("GET", "/v1/members", { token: adaSession })).status).toBe(200);
    expect((await h.call("PATCH", `/v1/members/${me}/role`, { token: adaSession, body: { role: "member" } })).status).toBe(403);
  });
});
