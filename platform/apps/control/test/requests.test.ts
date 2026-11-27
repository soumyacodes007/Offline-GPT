import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHarness, json, sessionFrom, type Harness } from "./harness";

let h: Harness;
let owner: string;
let ownerId: string;
let ada: string;
let adaId: string;

beforeEach(async () => {
  h = await createHarness();
  owner = await h.setupOwner();
  ownerId = String((await json(await h.call("GET", "/v1/me", { token: owner }))).id);
  const scim = String((await json(await h.call("POST", "/v1/settings/scim-token", { token: owner }))).token);
  adaId = String((await json(await h.call("POST", "/scim/v2/Users", { scim, body: { userName: "ada@example.test" } }))).id);
  ada = sessionFrom(await h.oidcSignIn({ sub: "a", email: "ada@example.test", name: "Ada" }));
  // Finance documents are closed by default; Ada starts without access.
});
afterEach(async () => {
  await h.close();
});

/** Jumping days ahead also ends the owner's 12-hour session; sign in again with the break-glass password. */
async function ownerSignsInAgain() {
  owner = String((await json(await h.call("POST", "/auth/local", { body: { email: "owner@example.test", password: "correct horse battery" } }))).token);
}

const ask = (token: string, body: Record<string, unknown> = {}) =>
  h.call("POST", "/v1/requests", { token, body: { kind: "knowledge-document", target: "docs/finance/*", purpose: "Quarterly report", durationDays: 7, ...body } });

async function requestId(response: Response): Promise<string> {
  const body = await json(response);
  const request = body.request;
  if (typeof request !== "object" || request === null || !("id" in request)) throw new Error("no request");
  return String(request.id);
}

const canRead = async (memberId: string, id: string) =>
  (await json(await h.call("POST", "/v1/access/check", { token: owner, body: { memberId, kind: "knowledge-document", id } }))).allowed;

test("approval grants time-limited access with the purpose as the reason", async () => {
  const id = await requestId(await ask(ada));
  expect(await canRead(adaId, "docs/finance/q3")).toBe(false);
  expect((await h.call("POST", `/v1/requests/${id}/approve`, { token: owner })).status).toBe(200);
  expect(await canRead(adaId, "docs/finance/q3")).toBe(true);
  const rules = await json(await h.call("GET", "/v1/rules", { token: owner }));
  expect(rules.rules).toEqual([expect.objectContaining({ principalRef: adaId, reason: 'Approved request: "Quarterly report"' })]);
  h.advance(7 * 24 * 60 * 60 * 1000 + 1000);
  await ownerSignsInAgain();
  expect(await canRead(adaId, "docs/finance/q3")).toBe(false);
});

test("asking twice returns the same pending request", async () => {
  const first = await requestId(await ask(ada));
  const again = await ask(ada, { purpose: "Different words" });
  expect(again.status).toBe(200);
  expect(await requestId(again)).toBe(first);
});

test("two simultaneous approvals give exactly one success", async () => {
  const id = await requestId(await ask(ada));
  const results = await Promise.all([1, 2, 3].map(() => h.call("POST", `/v1/requests/${id}/approve`, { token: owner })));
  expect(results.map((response) => response.status).sort()).toEqual([200, 409, 409]);
  expect(((await json(await h.call("GET", "/v1/rules", { token: owner }))).rules as unknown[]).length).toBe(1);
});

test("nobody decides their own request, members cannot decide at all", async () => {
  const own = await requestId(await ask(owner));
  expect((await h.call("POST", `/v1/requests/${own}/approve`, { token: owner })).status).toBe(403);
  const adas = await requestId(await ask(ada, { target: "docs/legal/*" }));
  expect((await h.call("POST", `/v1/requests/${adas}/approve`, { token: ada })).status).toBe(403);
});

test("decline, cancel and expiry all end a request", async () => {
  const declined = await requestId(await ask(ada));
  expect((await h.call("POST", `/v1/requests/${declined}/decline`, { token: owner, body: { note: "Use the summary instead" } })).status).toBe(200);
  expect((await h.call("POST", `/v1/requests/${declined}/approve`, { token: owner })).status).toBe(409);

  const cancelled = await requestId(await ask(ada, { target: "docs/legal/*" }));
  expect((await h.call("POST", `/v1/requests/${cancelled}/cancel`, { token: ada })).status).toBe(200);

  const stale = await requestId(await ask(ada, { target: "docs/hr/*" }));
  h.advance(7 * 24 * 60 * 60 * 1000 + 1);
  await ownerSignsInAgain();
  expect((await h.call("POST", `/v1/requests/${stale}/approve`, { token: owner })).status).toBe(409);
  ada = sessionFrom(await h.oidcSignIn({ sub: "a", email: "ada@example.test", name: "Ada" }));
  const mine = await json(await h.call("GET", "/v1/requests", { token: ada }));
  const statuses = Object.fromEntries((mine.requests as Array<{ id: string; status: string; note: string | null }>).map((request) => [request.id, request.status]));
  expect(statuses).toEqual({ [declined]: "declined", [cancelled]: "cancelled", [stale]: "expired" });
});

test("a member can have at most 20 pending requests", async () => {
  for (let index = 0; index < 20; index += 1) expect((await ask(ada, { target: `docs/area-${index}/*` })).status).toBe(201);
  expect((await ask(ada, { target: "docs/one-more/*" })).status).toBe(409);
});

test("the audit log records the whole story and pages newest first", async () => {
  const id = await requestId(await ask(ada));
  await h.call("POST", `/v1/requests/${id}/approve`, { token: owner });
  const page = await json(await h.call("GET", "/v1/audit?action=request.", { token: owner }));
  expect((page.events as Array<{ action: string; actor: string }>).map((event) => [event.action, event.actor])).toEqual([
    ["request.approved", ownerId],
    ["request.created", adaId],
  ]);
  const first = await json(await h.call("GET", "/v1/audit?limit=2", { token: owner }));
  expect(typeof first.nextBefore).toBe("number");
  const older = await json(await h.call("GET", `/v1/audit?limit=2&before=${String(first.nextBefore)}`, { token: owner }));
  expect((older.events as unknown[]).length).toBe(2);
  expect((await h.call("GET", "/v1/audit", { token: ada })).status).toBe(403);
});
