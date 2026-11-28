import { afterEach, expect, test } from "bun:test";
import { auditEvents, mcpConnections } from "@offlinegpt-platform/db";
import { createHarness, json, sessionFrom, type Harness } from "./harness";

const SECRET = "Bearer tracker-secret-value";
const TRACKER = "http://tracker.internal.test/mcp";
const BROKEN = "http://broken.internal.test/mcp";

type Seen = { method: string; authorization: string | null; session: string | null };
let seen: Seen[] = [];
let h: Harness;

/** A company tool server: issues a session, answers as an event stream, and checks its credential. */
async function trackerServer(input: string | URL | Request, init?: RequestInit): Promise<Response | null> {
  const url = input instanceof Request ? input.url : input.toString();
  if (url === BROKEN) return new Response("down", { status: 502 });
  if (url !== TRACKER) return null;
  const headers = new Headers(init?.headers);
  const request = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
  seen.push({ method: request.method, authorization: headers.get("authorization"), session: headers.get("mcp-session-id") });
  if (headers.get("authorization") !== SECRET) return new Response("unauthorized", { status: 401 });
  if (request.id === undefined) return new Response(null, { status: 202 });
  const results: Record<string, unknown> = {
    initialize: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "tracker", version: "1" } },
    "tools/list": { tools: [{ name: "find_ticket", description: "Find a ticket by number.", inputSchema: { type: "object", properties: { number: { type: "integer" } } } }] },
    "tools/call": { content: [{ type: "text", text: `Ticket ${request.params?.arguments?.number}: printer on floor 3 is jammed` }] },
  };
  const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: results[request.method] })}\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream", ...(request.method === "initialize" ? { "mcp-session-id": "sess-1" } : {}) } });
}

async function setup(secretsKey: string | null = "a-deployment-secrets-key-of-32-chars!") {
  seen = [];
  h = await createHarness({ ...(secretsKey ? { secretsKey } : {}), route: trackerServer });
  const owner = await h.setupOwner();
  const scim = String((await json(await h.call("POST", "/v1/settings/scim-token", { token: owner }))).token);
  const adaId = String((await json(await h.call("POST", "/scim/v2/Users", { scim, body: { userName: "ada@example.test" } }))).id);
  await h.call("POST", "/scim/v2/Users", { scim, body: { userName: "bob@example.test" } });
  const ada = sessionFrom(await h.oidcSignIn({ sub: "a", email: "ada@example.test", name: "Ada" }));
  const bob = sessionFrom(await h.oidcSignIn({ sub: "b", email: "bob@example.test", name: "Bob" }));
  const keyOf = async (token: string) => String((await json(await h.call("POST", "/v1/me/inference-key", { token }))).key);
  return { owner, adaId, adaKey: await keyOf(ada), bobKey: await keyOf(bob) };
}
afterEach(async () => {
  await h.close();
});

const rpc = async (key: string, method: string, params?: unknown) =>
  (await h.app.request("/mcp", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, ...(params === undefined ? {} : { params }) }) })).json();
const toolNames = async (key: string): Promise<string[]> => (await rpc(key, "tools/list")).result.tools.map((tool: { name: string }) => tool.name);

test("an allowed member's agent lists and calls a connection's tools with the stored credential", async () => {
  const { owner, adaId, adaKey, bobKey } = await setup();
  const saved = await h.call("POST", "/v1/library/connections", { token: owner, body: { slug: "tracker", title: "Ticket tracker", description: "IT tickets", url: TRACKER, header: { name: "Authorization", value: SECRET } } });
  expect(saved.status).toBe(201);
  // Closed until a rule allows someone.
  expect(await toolNames(adaKey)).not.toContain("tracker__find_ticket");
  await h.call("POST", "/v1/rules", { token: owner, body: { kind: "mcp-connection", target: "tracker", effect: "allow", principal: { type: "member", id: adaId }, reason: "IT desk" } });

  expect(await toolNames(adaKey)).toContain("tracker__find_ticket");
  expect(await toolNames(bobKey)).not.toContain("tracker__find_ticket");
  const called = await rpc(adaKey, "tools/call", { name: "tracker__find_ticket", arguments: { number: 42 } });
  expect(called.result.content[0].text).toBe("Ticket 42: printer on floor 3 is jammed");
  // The server's session header is carried after initialize.
  expect(seen.filter((request) => request.method === "tools/call").map((request) => request.session)).toEqual(["sess-1"]);

  const refused = await rpc(bobKey, "tools/call", { name: "tracker__find_ticket", arguments: { number: 42 } });
  expect(refused.result.isError).toBe(true);
  const events = await h.db.select().from(auditEvents);
  expect(events.filter((event) => event.action === "connection.tool_called").map((event) => event.details)).toEqual([{ slug: "tracker", tool: "find_ticket" }]);
});

test("the credential is encrypted at rest and never shown to admins", async () => {
  const { owner } = await setup();
  await h.call("POST", "/v1/library/connections", { token: owner, body: { slug: "tracker", title: "Ticket tracker", description: "IT tickets", url: TRACKER, header: { name: "Authorization", value: SECRET } } });
  const [row] = await h.db.select().from(mcpConnections);
  expect(row?.headerValueSealed).not.toContain("tracker-secret");
  const listed = JSON.stringify(await json(await h.call("GET", "/v1/library/connections", { token: owner })));
  expect(listed).toContain('"hasSecret":true');
  expect(listed).not.toContain("tracker-secret");
  // Saving again without a header keeps the stored credential.
  await h.call("POST", "/v1/library/connections", { token: owner, body: { slug: "tracker", title: "Tracker", description: "IT tickets", url: TRACKER } });
  const [kept] = await h.db.select().from(mcpConnections);
  expect(kept?.headerValueSealed).toBe(row?.headerValueSealed ?? "");
});

test("a broken server hides only its own tools, and credentials need SECRETS_KEY", async () => {
  const { owner, adaKey } = await setup();
  for (const [slug, url] of [["tracker", TRACKER], ["broken", BROKEN]] as const) {
    await h.call("POST", "/v1/library/connections", { token: owner, body: { slug, title: slug, description: "x", url, ...(slug === "tracker" ? { header: { name: "Authorization", value: SECRET } } : {}) } });
    await h.call("POST", "/v1/rules", { token: owner, body: { kind: "mcp-connection", target: slug, effect: "allow", principal: { type: "everyone" }, reason: "all staff" } });
  }
  const names = await toolNames(adaKey);
  expect(names).toContain("tracker__find_ticket");
  expect(names).toContain("search_knowledge");
  const failed = await rpc(adaKey, "tools/call", { name: "broken__anything", arguments: {} });
  expect(failed.result.isError).toBe(true);
  expect(failed.result.content[0].text).toContain("HTTP 502");
  await h.close();

  const plain = await setup(null);
  const refused = await h.call("POST", "/v1/library/connections", { token: plain.owner, body: { slug: "tracker", title: "t", description: "x", url: TRACKER, header: { name: "Authorization", value: SECRET } } });
  expect(refused.status).toBe(400);
});
