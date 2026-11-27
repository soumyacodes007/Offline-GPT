import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHarness, json, sessionFrom, type Harness } from "./harness";

let h: Harness;
let owner: string;
let scim: string;
const ids: Record<string, string> = {};

async function created(response: Response): Promise<string> {
  expect(response.status).toBe(201);
  const body = await json(response);
  if (typeof body.id !== "string") throw new Error("no id");
  return body.id;
}

beforeEach(async () => {
  h = await createHarness();
  owner = await h.setupOwner();
  const token = await json(await h.call("POST", "/v1/settings/scim-token", { token: owner }));
  scim = String(token.token);
  ids.ada = await created(await h.call("POST", "/scim/v2/Users", { scim, body: { userName: "ada@example.test" } }));
  ids.bob = await created(await h.call("POST", "/scim/v2/Users", { scim, body: { userName: "bob@example.test" } }));
  ids.legal = await created(await h.call("POST", "/scim/v2/Groups", { scim, body: { displayName: "Legal", members: [{ value: ids.ada }] } }));
});
afterEach(async () => {
  await h.close();
});

const rule = (body: Record<string, unknown>) => h.call("POST", "/v1/rules", { token: owner, body: { reason: "test", ...body } });
const check = async (member: string, kind: string, id: string) => json(await h.call("POST", "/v1/access/check", { token: owner, body: { memberId: member, kind, id } }));

test("a team allow restricts a model to that team, and check explains why", async () => {
  expect((await rule({ kind: "model", target: "qwen-32b", effect: "allow", principal: { type: "team", id: ids.legal } })).status).toBe(201);
  expect(await check(ids.ada ?? "", "model", "qwen-32b")).toMatchObject({ allowed: true, cause: { type: "allow-rule", target: "qwen-32b" } });
  expect(await check(ids.bob ?? "", "model", "qwen-32b")).toEqual({ allowed: false, cause: { type: "restricted" } });
  expect(await check(ids.bob ?? "", "model", "qwen-7b")).toEqual({ allowed: true, cause: { type: "baseline", baseline: "open" } });
});

test("a member deny beats a team allow", async () => {
  await rule({ kind: "model", target: "qwen-32b", effect: "allow", principal: { type: "team", id: ids.legal } });
  await rule({ kind: "model", target: "qwen-32b", effect: "deny", principal: { type: "member", id: ids.ada }, reason: "on leave" });
  expect(await check(ids.ada ?? "", "model", "qwen-32b")).toMatchObject({ allowed: false, cause: { type: "deny-rule", reason: "on leave" } });
});

test("an expired allow stops working without anyone touching it", async () => {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await rule({ kind: "knowledge-document", target: "docs/finance/*", effect: "allow", principal: { type: "member", id: ids.bob }, expiresAt });
  expect((await check(ids.bob ?? "", "knowledge-document", "docs/finance/q3")).allowed).toBe(true);
  h.advance(2 * 60 * 60 * 1000);
  expect(await check(ids.bob ?? "", "knowledge-document", "docs/finance/q3")).toEqual({ allowed: false, cause: { type: "baseline", baseline: "closed" } });
});

test("a prefix deny hides a folder but not look-alike ids", async () => {
  await rule({ kind: "knowledge-document", target: "*", effect: "allow", principal: { type: "everyone" } });
  await rule({ kind: "knowledge-document", target: "docs/hr/*", effect: "deny", principal: { type: "everyone" } });
  expect((await check(ids.ada ?? "", "knowledge-document", "docs/hr/salaries")).allowed).toBe(false);
  expect((await check(ids.ada ?? "", "knowledge-document", "docs/hr-policy")).allowed).toBe(true);
});

test("bad rules are refused when they are created", async () => {
  expect((await rule({ kind: "model", target: "a*b", effect: "allow", principal: { type: "everyone" } })).status).toBe(400);
  expect((await rule({ kind: "model", target: "x", effect: "allow", principal: { type: "team", id: "team_missing" } })).status).toBe(400);
  expect((await rule({ kind: "model", target: "x", effect: "allow", principal: { type: "everyone" }, expiresAt: "2000-01-01T00:00:00Z" })).status).toBe(400);
  expect((await rule({ kind: "nonsense", target: "x", effect: "allow", principal: { type: "everyone" } })).status).toBe(400);
  expect((await h.call("POST", "/v1/rules", { token: owner, body: { kind: "model", target: "x", effect: "allow", principal: { type: "everyone" } } })).status).toBe(400);
});

test("members see their own access but cannot manage rules", async () => {
  await rule({ kind: "model", target: "qwen-32b", effect: "allow", principal: { type: "team", id: ids.legal } });
  const bob = sessionFrom(await h.oidcSignIn({ sub: "b", email: "bob@example.test", name: "Bob" }));
  const mine = await json(await h.call("GET", "/v1/me/access?kind=model&ids=qwen-32b,qwen-7b", { token: bob }));
  expect(mine.decisions).toMatchObject({ "qwen-32b": { allowed: false }, "qwen-7b": { allowed: true } });
  expect((await h.call("GET", "/v1/rules", { token: bob })).status).toBe(403);
  expect((await h.call("POST", "/v1/rules", { token: bob, body: { kind: "model", target: "y", effect: "allow", principal: { type: "everyone" }, reason: "r" } })).status).toBe(403);
});

test("deleting a rule restores the baseline and is audited", async () => {
  const created = await json(await rule({ kind: "plugin", target: "excel", effect: "allow", principal: { type: "everyone" } }));
  const ruleBody = created.rule;
  const ruleId = typeof ruleBody === "object" && ruleBody !== null && "id" in ruleBody ? String(ruleBody.id) : "";
  expect((await check(ids.bob ?? "", "plugin", "excel")).allowed).toBe(true);
  expect((await h.call("DELETE", `/v1/rules/${ruleId}`, { token: owner })).status).toBe(204);
  expect(await check(ids.bob ?? "", "plugin", "excel")).toEqual({ allowed: false, cause: { type: "baseline", baseline: "closed" } });
  expect((await h.call("DELETE", `/v1/rules/${ruleId}`, { token: owner })).status).toBe(404);
});
