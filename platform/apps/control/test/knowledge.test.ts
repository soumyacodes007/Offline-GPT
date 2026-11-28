import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { auditEvents } from "@offlinegpt-platform/db";
import { splitIntoSections } from "../src/knowledge/chunk";
import { createHarness, json, sessionFrom, type Harness } from "./harness";

const HANDBOOK = `# Leave policy
Everyone gets 24 days of paid leave each year.

## Parental leave
Parents get 26 weeks of paid parental leave.

## Salary bands
Band A pays 40,000 to 55,000.`;

let h: Harness;
let owner: string;
let scim: string;
let legal: string;
let ada: string;
let bob: string;

async function body(response: Response) {
  return json(response);
}

beforeEach(async () => {
  h = await createHarness();
  owner = await h.setupOwner();
  scim = String((await body(await h.call("POST", "/v1/settings/scim-token", { token: owner }))).token);
  const adaId = String((await body(await h.call("POST", "/scim/v2/Users", { scim, body: { userName: "ada@example.test" } }))).id);
  await h.call("POST", "/scim/v2/Users", { scim, body: { userName: "bob@example.test" } });
  legal = String((await body(await h.call("POST", "/scim/v2/Groups", { scim, body: { displayName: "HR", members: [{ value: adaId }] } }))).id);
  ada = sessionFrom(await h.oidcSignIn({ sub: "a", email: "ada@example.test", name: "Ada" }));
  bob = sessionFrom(await h.oidcSignIn({ sub: "b", email: "bob@example.test", name: "Bob" }));
});
afterEach(async () => {
  await h.close();
});

const upload = (extra: Record<string, unknown> = {}) =>
  h.call("POST", "/v1/knowledge/documents", { token: owner, body: { path: "policies/hr/handbook", title: "HR handbook", content: HANDBOOK, audience: [{ type: "role", id: "member" }], ...extra } });
const search = async (token: string, query: string) => {
  const response = await h.call("POST", "/v1/knowledge/search", { token, body: { query } });
  expect(response.status).toBe(200);
  return ((await body(response)).results as Array<{ section: string; heading: string; sensitivity: string }>);
};

describe("sections", () => {
  test("split at headings, then at paragraphs when long", () => {
    expect(splitIntoSections("Doc", HANDBOOK).map((section) => section.heading)).toEqual(["Leave policy", "Parental leave", "Salary bands"]);
    const long = splitIntoSections("Doc", Array.from({ length: 10 }, (_, index) => `Paragraph ${index} ${"x".repeat(300)}`).join("\n\n"));
    expect(long.length).toBeGreaterThan(1);
    expect(long.every((section) => section.body.length <= 1200)).toBe(true);
  });
});

test("documents are closed until their audience is set", async () => {
  await h.call("POST", "/v1/knowledge/documents", { token: owner, body: { path: "policies/secret", title: "Secret plan", content: "The parental leave pilot starts in May." } });
  expect(await search(ada, "parental")).toEqual([]);
  expect((await upload()).status).toBe(201);
  expect((await search(ada, "parental")).map((hit) => hit.heading)).toEqual(["Parental leave"]);
});

test("a restricted section needs a rule on the section itself", async () => {
  const uploaded = await body(await upload());
  const document = uploaded.document as { id: string };
  const detail = await body(await h.call("GET", `/v1/knowledge/documents/${document.id}`, { token: owner }));
  const salary = (detail.sections as Array<{ id: string; heading: string; resourceId: string }>).find((section) => section.heading === "Salary bands");
  expect(salary?.resourceId).toBe("policies/hr/handbook#3");
  await h.call("PATCH", `/v1/knowledge/sections/${salary?.id ?? ""}`, { token: owner, body: { sensitivity: "restricted" } });

  expect(await search(ada, "band")).toEqual([]);
  await h.call("POST", "/v1/rules", { token: owner, body: { kind: "knowledge-section", target: "policies/hr/handbook#3", effect: "allow", principal: { type: "team", id: legal }, reason: "HR only" } });
  expect((await search(ada, "band")).map((hit) => [hit.heading, hit.sensitivity])).toEqual([["Salary bands", "restricted"]]);
  expect(await search(bob, "band")).toEqual([]);
  // The section rule restricts that section only.
  expect((await search(bob, "parental")).length).toBe(1);

  const events = await h.db.select().from(auditEvents);
  expect(events.filter((event) => event.action === "knowledge.sensitive_read").map((event) => event.details)).toEqual([{ query: "band", sections: ["policies/hr/handbook#3"] }]);
});

test("a section deny hides it from everyone it names", async () => {
  await upload();
  await h.call("POST", "/v1/rules", { token: owner, body: { kind: "knowledge-section", target: "policies/hr/handbook#2", effect: "deny", principal: { type: "member", id: String((await body(await h.call("GET", "/v1/me", { token: bob }))).id) }, reason: "test" } });
  expect(await search(bob, "parental")).toEqual([]);
  expect((await search(ada, "parental")).length).toBe(1);
});

test("re-uploading a path replaces its sections; members cannot upload", async () => {
  await upload();
  await upload({ content: "# Leave policy\nEveryone gets 30 days." });
  const documents = (await body(await h.call("GET", "/v1/knowledge/documents", { token: owner }))).documents as Array<{ sections: number }>;
  expect(documents).toHaveLength(1);
  expect(documents[0]?.sections).toBe(1);
  expect((await h.call("POST", "/v1/knowledge/documents", { token: ada, body: { path: "x", title: "x", content: "x" } })).status).toBe(403);
});

test("the workspace MCP tool searches as the key's member", async () => {
  await upload();
  const adaKey = String((await body(await h.call("POST", "/v1/me/inference-key", { token: ada }))).key);
  const rpc = (key: string, method: string, params?: unknown) =>
    h.app.request("/mcp", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }) });

  const init = await (await rpc(adaKey, "initialize", { protocolVersion: "2025-06-18" })).json();
  expect(init.result.serverInfo.name).toBe("offlinegpt-workspace");
  const tools = await (await rpc(adaKey, "tools/list")).json();
  expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toContain("search_knowledge");
  const call = await (await rpc(adaKey, "tools/call", { name: "search_knowledge", arguments: { query: "parental" } })).json();
  expect(call.result.content[0].text).toContain("26 weeks");
  expect((await rpc("ogk_wrong", "tools/list")).status).toBe(401);
});
