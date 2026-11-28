import { afterEach, expect, test } from "bun:test";
import { createHarness, json, type Harness } from "./harness";

let h: Harness;
afterEach(async () => {
  await h.close();
});

async function setup() {
  h = await createHarness();
  const owner = await h.setupOwner();
  const scim = String((await json(await h.call("POST", "/v1/settings/scim-token", { token: owner }))).token);
  const adaId = String((await json(await h.call("POST", "/scim/v2/Users", { scim, body: { userName: "ada@example.test" } }))).id);
  const bobId = String((await json(await h.call("POST", "/scim/v2/Users", { scim, body: { userName: "bob@example.test" } }))).id);
  return { owner, scim, adaId, bobId };
}

const canUse = async (owner: string, memberId: string) =>
  (await json(await h.call("POST", "/v1/access/check", { token: owner, body: { memberId, kind: "plugin", id: "finance-pack" } }))).allowed;

test("admins make a team, fill it, and rules on it grant access", async () => {
  const { owner, adaId, bobId } = await setup();
  const created = await h.call("POST", "/v1/teams", { token: owner, body: { name: "Month-end close" } });
  expect(created.status).toBe(201);
  const teamId = String(((await json(created)).team as { id: string }).id);
  expect((await h.call("POST", "/v1/teams", { token: owner, body: { name: "Month-end close" } })).status).toBe(409);

  await h.call("POST", "/v1/rules", { token: owner, body: { kind: "plugin", target: "finance-pack", effect: "allow", principal: { type: "team", id: teamId }, reason: "Close team" } });
  expect(await canUse(owner, adaId)).toBe(false);
  expect((await h.call("PUT", `/v1/teams/${teamId}/members`, { token: owner, body: { memberIds: [adaId] } })).status).toBe(200);
  expect(await canUse(owner, adaId)).toBe(true);
  expect(await canUse(owner, bobId)).toBe(false);

  // Replacing the members removes Ada.
  await h.call("PUT", `/v1/teams/${teamId}/members`, { token: owner, body: { memberIds: [bobId] } });
  expect(await canUse(owner, adaId)).toBe(false);
  expect((await h.call("PUT", `/v1/teams/${teamId}/members`, { token: owner, body: { memberIds: ["mem_nobody"] } })).status).toBe(400);

  const listed = await json(await h.call("GET", "/v1/teams", { token: owner }));
  expect(listed.teams).toEqual([{ id: teamId, name: "Month-end close", source: "manual", members: 1 }]);
  expect((await h.call("DELETE", `/v1/teams/${teamId}`, { token: owner })).status).toBe(204);
  expect(await canUse(owner, bobId)).toBe(false);
});

test("directory teams stay with SCIM, and SCIM never sees manual teams", async () => {
  const { owner, scim, adaId } = await setup();
  const directoryTeam = String((await json(await h.call("POST", "/scim/v2/Groups", { scim, body: { displayName: "Finance", members: [{ value: adaId }] } }))).id);
  expect((await h.call("PUT", `/v1/teams/${directoryTeam}/members`, { token: owner, body: { memberIds: [] } })).status).toBe(409);
  expect((await h.call("DELETE", `/v1/teams/${directoryTeam}`, { token: owner })).status).toBe(409);

  const manual = String(((await json(await h.call("POST", "/v1/teams", { token: owner, body: { name: "Project Falcon" } }))).team as { id: string }).id);
  const groups = await json(await h.call("GET", "/scim/v2/Groups", { scim }));
  expect((groups.Resources as Array<{ displayName: string }>).map((group) => group.displayName)).toEqual(["Finance"]);
  expect((await h.call("GET", `/scim/v2/Groups/${manual}`, { scim })).status).toBe(404);
  expect((await h.call("DELETE", `/scim/v2/Groups/${manual}`, { scim })).status).toBe(404);
});
