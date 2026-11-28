import { afterEach, expect, test } from "bun:test";
import { createHarness, json, sessionFrom, type Harness } from "./harness";

let h: Harness;
afterEach(async () => {
  await h.close();
});

async function setup() {
  h = await createHarness();
  const owner = await h.setupOwner();
  const scim = String((await json(await h.call("POST", "/v1/settings/scim-token", { token: owner }))).token);
  const people: Record<string, { id: string; token: string }> = {};
  for (const name of ["ada", "bob", "cy"]) {
    const id = String((await json(await h.call("POST", "/scim/v2/Users", { scim, body: { userName: `${name}@example.test` } }))).id);
    people[name] = { id, token: sessionFrom(await h.oidcSignIn({ sub: name, email: `${name}@example.test`, name })) };
  }
  const person = (name: string) => people[name] ?? { id: "", token: "" };
  return { owner, ada: person("ada"), bob: person("bob"), cy: person("cy") };
}

const makeRole = async (owner: string, name: string, permissions: string[]) =>
  String(((await json(await h.call("POST", "/v1/roles", { token: owner, body: { name, permissions } }))).role as { id: string }).id);

test("a custom role opens exactly its areas to a member", async () => {
  const { owner, ada } = await setup();
  const editor = await makeRole(owner, "Knowledge editor", ["knowledge"]);
  const upload = () => h.call("POST", "/v1/knowledge/documents", { token: ada.token, body: { path: "policies/leave", title: "Leave", content: "# Leave\n24 days." } });

  expect((await upload()).status).toBe(403);
  expect((await json(await h.call("GET", "/v1/me", { token: ada.token }))).permissions).toEqual([]);
  expect((await h.call("PATCH", `/v1/members/${ada.id}/custom-role`, { token: owner, body: { customRoleId: editor } })).status).toBe(200);

  expect((await upload()).status).toBe(201);
  expect((await json(await h.call("GET", "/v1/me", { token: ada.token }))).permissions).toEqual(["knowledge"]);
  expect((await h.call("GET", "/v1/audit", { token: ada.token })).status).toBe(403);
  expect((await h.call("GET", "/v1/rules", { token: ada.token })).status).toBe(403);

  // Changing the role changes what holders can do at once.
  await h.call("PUT", `/v1/roles/${editor}`, { token: owner, body: { name: "Knowledge editor", permissions: ["knowledge", "audit"] } });
  expect((await h.call("GET", "/v1/audit", { token: ada.token })).status).toBe(200);
  expect((await h.call("DELETE", `/v1/roles/${editor}`, { token: owner })).status).toBe(204);
  expect((await upload()).status).toBe(403);
});

test("only owners manage roles, and roles never grant owner powers", async () => {
  const { owner, ada, bob } = await setup();
  await h.call("PATCH", `/v1/members/${bob.id}/role`, { token: owner, body: { role: "admin" } });
  expect((await h.call("POST", "/v1/roles", { token: bob.token, body: { name: "Mine", permissions: ["people"] } })).status).toBe(403);

  const peopleRole = await makeRole(owner, "People desk", ["people"]);
  expect((await h.call("PATCH", `/v1/members/${ada.id}/custom-role`, { token: bob.token, body: { customRoleId: peopleRole } })).status).toBe(403);
  await h.call("PATCH", `/v1/members/${ada.id}/custom-role`, { token: owner, body: { customRoleId: peopleRole } });
  expect((await h.call("GET", "/v1/members", { token: ada.token })).status).toBe(200);
  expect((await h.call("POST", "/v1/settings/scim-token", { token: ada.token })).status).toBe(403);
  expect((await h.call("PATCH", `/v1/members/${ada.id}/role`, { token: ada.token, body: { role: "admin" } })).status).toBe(403);
  expect((await h.call("POST", "/v1/roles", { token: owner, body: { name: "Bad", permissions: ["everything"] } })).status).toBe(400);
});

test("a member with the requests permission decides others' requests but not their own", async () => {
  const { owner, ada, cy } = await setup();
  const desk = await makeRole(owner, "Access desk", ["requests"]);
  await h.call("PATCH", `/v1/members/${ada.id}/custom-role`, { token: owner, body: { customRoleId: desk } });
  const ask = async (token: string) => String(((await json(await h.call("POST", "/v1/requests", { token, body: { kind: "plugin", target: "finance-pack", purpose: "Month-end close", durationDays: 30 } }))).request as { id: string }).id);
  const cysRequest = await ask(cy.token);
  const adasRequest = await ask(ada.token);

  const everyone = await json(await h.call("GET", "/v1/requests?all=1", { token: ada.token }));
  expect((everyone.requests as unknown[]).length).toBe(2);
  expect((await h.call("POST", `/v1/requests/${cysRequest}/approve`, { token: ada.token, body: {} })).status).toBe(200);
  expect((await h.call("POST", `/v1/requests/${adasRequest}/approve`, { token: ada.token, body: {} })).status).toBe(403);

  // Without the permission, `all=1` shows only your own.
  const cysView = await json(await h.call("GET", "/v1/requests?all=1", { token: cy.token }));
  expect((cysView.requests as unknown[]).length).toBe(1);
});
