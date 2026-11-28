import { afterEach, expect, test } from "bun:test";
import { mcpConnections } from "@offlinegpt-platform/db";
import { strToU8, zipSync } from "fflate";
import { readFrontMatter, slugify } from "../src/plugins/parse";
import { createHarness, json, sessionFrom, type Harness } from "./harness";

const TRACKER = "http://tracker.internal.test/mcp";
let h: Harness;
let open = false;

/** Answers just enough MCP for the platform to list one tool. */
async function trackerServer(input: string | URL | Request, init?: RequestInit): Promise<Response | null> {
  const url = input instanceof Request ? input.url : input.toString();
  if (url !== TRACKER) return null;
  const request = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
  if (request.id === undefined) return new Response(null, { status: 202 });
  const result = request.method === "tools/list" ? { tools: [{ name: "find_ticket" }] } : { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "t", version: "1" } };
  return Response.json({ jsonrpc: "2.0", id: request.id, result });
}

type PluginFiles = Record<string, string>;
const FINANCE: PluginFiles = {
  "finance-pack/.claude-plugin/plugin.json": JSON.stringify({ name: "Finance Pack", description: "Month-end close helpers", version: "1.2.0" }),
  "finance-pack/skills/close/SKILL.md": "---\nname: month-close\ndescription: Run the month-end close checklist\n---\n## Steps\nReconcile the ledger first.",
  "finance-pack/skills/variance/SKILL.md": "---\nname: variance\ndescription: Explain budget variance\n---\nCompare actuals to budget.",
  "finance-pack/.mcp.json": JSON.stringify({
    mcpServers: {
      tracker: { type: "http", url: TRACKER },
      erp: { type: "http", url: "http://erp.internal.test/mcp", headers: { Authorization: "Bearer ${ERP_TOKEN}" } },
      local: { command: "npx", args: ["some-local-server"] },
    },
  }),
};

const zip = (files: PluginFiles) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])))).toString("base64");

async function setup() {
  h = await createHarness({ secretsKey: "a-deployment-secrets-key-of-32-chars!", route: trackerServer });
  open = true;
  const owner = await h.setupOwner();
  const scim = String((await json(await h.call("POST", "/v1/settings/scim-token", { token: owner }))).token);
  const adaId = String((await json(await h.call("POST", "/scim/v2/Users", { scim, body: { userName: "ada@example.test" } }))).id);
  const ada = sessionFrom(await h.oidcSignIn({ sub: "a", email: "ada@example.test", name: "Ada" }));
  const adaKey = String((await json(await h.call("POST", "/v1/me/inference-key", { token: ada }))).key);
  return { owner, adaId, ada, adaKey };
}
afterEach(async () => {
  if (open) await h.close();
  open = false;
});

const toolNames = async (key: string): Promise<string[]> =>
  (await (await h.app.request("/mcp", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json()).result.tools.map((tool: { name: string }) => tool.name);
const mySkills = async (token: string): Promise<string[]> => ((await json(await h.call("GET", "/v1/me/library", { token }))).skills as Array<{ slug: string }>).map((skill) => skill.slug);

test("installing a plugin adds its skills and connections, closed until the plugin is allowed", async () => {
  const { owner, adaId, ada, adaKey } = await setup();
  const installed = await h.call("POST", "/v1/library/plugins", { token: owner, body: { base64: zip(FINANCE) } });
  expect(installed.status).toBe(201);
  const report = await json(installed);
  expect(report.plugin).toEqual({ slug: "finance-pack", title: "Finance Pack", version: "1.2.0" });
  expect(report.skills).toEqual(expect.arrayContaining(["finance-pack-month-close", "finance-pack-variance"]));
  expect(report.connections).toEqual(expect.arrayContaining([{ slug: "finance-pack-tracker", needsCredential: false }, { slug: "finance-pack-erp", needsCredential: true }]));
  expect(JSON.stringify(report.skipped)).toContain('MCP server \\"local\\"');

  // Skills are open by default, but a plugin's skills need the plugin's rule.
  expect(await mySkills(ada)).toEqual([]);
  expect(await toolNames(adaKey)).not.toContain("finance-pack-tracker__find_ticket");
  await h.call("POST", "/v1/rules", { token: owner, body: { kind: "plugin", target: "finance-pack", effect: "allow", principal: { type: "member", id: adaId }, reason: "Finance team" } });
  expect((await mySkills(ada)).sort()).toEqual(["finance-pack-month-close", "finance-pack-variance"]);
  expect(await toolNames(adaKey)).toContain("finance-pack-tracker__find_ticket");

  // A skill rule still narrows a plugin's skills.
  await h.call("POST", "/v1/rules", { token: owner, body: { kind: "skill", target: "finance-pack-variance", effect: "deny", principal: { type: "member", id: adaId }, reason: "Not yet" } });
  expect(await mySkills(ada)).toEqual(["finance-pack-month-close"]);
});

test("reinstalling replaces the plugin's items and keeps credentials an admin set", async () => {
  const { owner } = await setup();
  await h.call("POST", "/v1/library/plugins", { token: owner, body: { base64: zip(FINANCE) } });
  // The admin supplies the ERP credential the plugin couldn't carry.
  const credential = await h.call("POST", "/v1/library/connections", { token: owner, body: { slug: "finance-pack-erp", title: "ERP", description: "ERP", url: "http://erp.internal.test/mcp", header: { name: "Authorization", value: "Bearer real-erp-token" } } });
  expect(credential.status).toBe(201);

  const { ["finance-pack/skills/variance/SKILL.md"]: _dropped, ...smaller } = FINANCE;
  expect((await h.call("POST", "/v1/library/plugins", { token: owner, body: { base64: zip(smaller) } })).status).toBe(201);
  const listed = await json(await h.call("GET", "/v1/library/plugins", { token: owner }));
  expect(listed.plugins).toEqual([expect.objectContaining({ slug: "finance-pack", skills: ["finance-pack-month-close"] })]);
  const erp = (await h.db.select().from(mcpConnections)).find((row) => row.slug === "finance-pack-erp");
  expect(erp?.headerValueSealed).not.toBeNull();
  expect(erp?.pluginSlug).toBe("finance-pack");

  // Plugin items are managed through the plugin.
  expect((await h.call("DELETE", "/v1/library/skills/finance-pack-month-close", { token: owner })).status).toBe(409);
  expect((await h.call("DELETE", "/v1/library/connections/finance-pack-tracker", { token: owner })).status).toBe(409);
  expect((await h.call("DELETE", "/v1/library/plugins/finance-pack", { token: owner })).status).toBe(204);
  expect((await json(await h.call("GET", "/v1/library/skills", { token: owner }))).skills).toEqual([]);
  expect(await h.db.select().from(mcpConnections)).toEqual([]);
});

test("bad zips and taken names are refused", async () => {
  const { owner } = await setup();
  expect((await h.call("POST", "/v1/library/plugins", { token: owner, body: { base64: Buffer.from("not a zip").toString("base64") } })).status).toBe(400);
  expect((await h.call("POST", "/v1/library/plugins", { token: owner, body: { base64: zip({ "readme.md": "hi" }) } })).status).toBe(400);
  await h.call("POST", "/v1/library/skills", { token: owner, body: { slug: "finance-pack-variance", title: "Mine", description: "An admin's own skill", instructions: "x" } });
  const clash = await h.call("POST", "/v1/library/plugins", { token: owner, body: { base64: zip(FINANCE) } });
  expect(clash.status).toBe(409);
  expect((await json(clash)).message).toContain("finance-pack-variance");
});

test("names and front matter are read leniently", () => {
  expect(slugify("Finance Pack!")).toBe("finance-pack");
  expect(slugify("***")).toBe("");
  expect(readFrontMatter("---\nname: 'Close'\ndescription: \"Do it\"\n---\nBody")).toEqual({ fields: { name: "Close", description: "Do it" }, body: "Body" });
  expect(readFrontMatter("No front matter")).toEqual({ fields: {}, body: "No front matter" });
});
