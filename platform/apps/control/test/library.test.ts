import { afterEach, beforeEach, expect, test } from "bun:test";
import { auditEvents } from "@offlinegpt-platform/db";
import { createHarness, json, sessionFrom, type Harness } from "./harness";

let h: Harness;
let owner: string;
let ada: string;
let adaKey: string;

beforeEach(async () => {
  h = await createHarness();
  owner = await h.setupOwner();
  const scim = String((await json(await h.call("POST", "/v1/settings/scim-token", { token: owner }))).token);
  await h.call("POST", "/scim/v2/Users", { scim, body: { userName: "ada@example.test" } });
  ada = sessionFrom(await h.oidcSignIn({ sub: "a", email: "ada@example.test", name: "Ada" }));
  adaKey = String((await json(await h.call("POST", "/v1/me/inference-key", { token: ada }))).key);
});
afterEach(async () => {
  await h.close();
});

const publish = (slug: string, title: string) =>
  h.call("POST", "/v1/library/skills", { token: owner, body: { slug, title, description: `${title} the company way`, instructions: `## Steps\nWrite the ${title.toLowerCase()} using the house template.` } });

const rpc = async (key: string, method: string, params?: unknown) =>
  (await h.app.request("/mcp", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }) })).json();

test("admins publish skills and members see the ones they may use", async () => {
  expect((await publish("weekly-report", "Weekly report")).status).toBe(201);
  expect((await publish("press-release", "Press release")).status).toBe(201);
  const adaId = String((await json(await h.call("GET", "/v1/me", { token: ada }))).id);
  await h.call("POST", "/v1/rules", { token: owner, body: { kind: "skill", target: "press-release", effect: "deny", principal: { type: "member", id: adaId }, reason: "Comms team only" } });

  const mine = await json(await h.call("GET", "/v1/me/library", { token: ada }));
  expect((mine.skills as Array<{ slug: string }>).map((skill) => skill.slug)).toEqual(["weekly-report"]);
  expect((await h.call("POST", "/v1/library/skills", { token: ada, body: { slug: "x", title: "x", description: "x", instructions: "x" } })).status).toBe(403);
});

test("publishing the same slug replaces it, and bad slugs are refused", async () => {
  await publish("weekly-report", "Weekly report");
  await publish("weekly-report", "Weekly summary");
  const all = await json(await h.call("GET", "/v1/library/skills", { token: owner }));
  expect(all.skills).toEqual([expect.objectContaining({ slug: "weekly-report", title: "Weekly summary" })]);
  expect((await h.call("POST", "/v1/library/skills", { token: owner, body: { slug: "Bad Name", title: "x", description: "x", instructions: "x" } })).status).toBe(400);
  expect((await h.call("DELETE", "/v1/library/skills/weekly-report", { token: owner })).status).toBe(204);
  expect((await h.call("DELETE", "/v1/library/skills/weekly-report", { token: owner })).status).toBe(404);
  const actions = (await h.db.select().from(auditEvents)).map((event) => event.action);
  expect(actions.filter((action) => action.startsWith("library."))).toEqual(["library.skill.published", "library.skill.published", "library.skill.deleted"]);
});

test("the workspace agent lists and uses only skills its member may use", async () => {
  await publish("weekly-report", "Weekly report");
  await publish("press-release", "Press release");
  const adaId = String((await json(await h.call("GET", "/v1/me", { token: ada }))).id);
  await h.call("POST", "/v1/rules", { token: owner, body: { kind: "skill", target: "press-*", effect: "deny", principal: { type: "member", id: adaId }, reason: "Comms only" } });

  const tools = await rpc(adaKey, "tools/list");
  expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["search_knowledge", "list_skills", "use_skill"]);
  const listed = await rpc(adaKey, "tools/call", { name: "list_skills", arguments: {} });
  expect(listed.result.structuredContent.skills.map((skill: { slug: string }) => skill.slug)).toEqual(["weekly-report"]);
  const used = await rpc(adaKey, "tools/call", { name: "use_skill", arguments: { slug: "weekly-report" } });
  expect(used.result.content[0].text).toContain("house template");
  const refused = await rpc(adaKey, "tools/call", { name: "use_skill", arguments: { slug: "press-release" } });
  expect(refused.result.isError).toBe(true);
});
