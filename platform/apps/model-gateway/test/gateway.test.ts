import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { accessRules, inferenceKeys, members, openDatabase, teamMembers, teams, usageRecords, type DatabaseHandle } from "@offlinegpt-platform/db";
import { createGateway } from "../src/app";
import type { ModelConfig } from "../src/config";

const models: ModelConfig[] = [
  { alias: "main", displayName: "Qwen 7B", upstreamUrl: "http://vllm.internal:8000/v1", upstreamModel: "Qwen/Qwen2.5-7B-Instruct", contextLength: 16384 },
  { alias: "large", displayName: "Qwen 32B", upstreamUrl: "http://vllm-large.internal:8000/v1", upstreamModel: "Qwen/Qwen2.5-32B-Instruct", contextLength: 32768 },
];

let database: DatabaseHandle;
let upstreamCalls: Array<{ url: string; body: Record<string, unknown> }>;
let upstreamDown = false;
let limit: number | null = null;

function sse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
}

async function upstream(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (upstreamDown) throw new TypeError("fetch failed");
  const url = input instanceof Request ? input.url : input.toString();
  const body: Record<string, unknown> = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
  upstreamCalls.push({ url, body });
  if (body.stream === true) {
    // Split across chunk boundaries the way a real server can.
    const text = sse([{ choices: [{ delta: { content: "OFF" } }] }, { choices: [{ delta: { content: "LINE" } }] }, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } }]);
    const bytes = new TextEncoder().encode(text);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 30)); controller.enqueue(bytes.slice(30)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
  }
  return Response.json({ choices: [{ message: { role: "assistant", content: "OFFLINE" } }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
}

function gateway() {
  return createGateway({ db: database.db, models, dailyTokenLimit: limit, now: () => new Date(), fetch: upstream });
}

async function memberWithKey(id: string, key: string, active = true) {
  await database.db.insert(members).values({ id, email: `${id}@example.test`, name: id, active });
  await database.db.insert(inferenceKeys).values({ id: `k-${id}`, memberId: id, keyHash: createHash("sha256").update(key).digest("hex"), prefix: key.slice(0, 6) });
}

const call = (key: string, path: string, body?: unknown) =>
  Promise.resolve(gateway().request(path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));

beforeEach(async () => {
  database = openDatabase("pglite:memory");
  await database.migrate();
  upstreamCalls = [];
  upstreamDown = false;
  limit = null;
  await memberWithKey("ada", "key-ada");
  await memberWithKey("bob", "key-bob");
  await database.db.insert(teams).values({ id: "t-legal", name: "Legal" });
  await database.db.insert(teamMembers).values({ teamId: "t-legal", memberId: "ada" });
  await database.db.insert(accessRules).values({ id: "r1", kind: "model", target: "large", effect: "allow", principalType: "team", principalRef: "t-legal", reason: "Legal only", createdBy: "test" });
});
afterEach(async () => {
  await database.close();
});

test("model list shows only the models each member may use", async () => {
  const ada = await (await call("key-ada", "/v1/models")).json();
  const bob = await (await call("key-bob", "/v1/models")).json();
  expect(ada.data.map((model: { id: string }) => model.id)).toEqual(["main", "large"]);
  expect(bob.data.map((model: { id: string }) => model.id)).toEqual(["main"]);
});

test("a completion is forwarded with the upstream model name and its usage is recorded", async () => {
  const response = await call("key-bob", "/v1/chat/completions", { model: "main", messages: [{ role: "user", content: "Reply OFFLINE" }] });
  expect(response.status).toBe(200);
  expect((await response.json()).choices[0].message.content).toBe("OFFLINE");
  expect(upstreamCalls[0]).toMatchObject({ url: "http://vllm.internal:8000/v1/chat/completions", body: { model: "Qwen/Qwen2.5-7B-Instruct" } });
  expect(await database.db.select().from(usageRecords)).toEqual([expect.objectContaining({ memberId: "bob", model: "main", promptTokens: 10, completionTokens: 1, status: "completed" })]);
});

test("streaming passes through unchanged and records the final usage chunk", async () => {
  const response = await call("key-ada", "/v1/chat/completions", { model: "large", stream: true, messages: [{ role: "user", content: "hi" }] });
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const text = await response.text();
  expect(text).toContain('"content":"OFF"');
  expect(text).toContain("[DONE]");
  expect(upstreamCalls[0]?.body.stream_options).toEqual({ include_usage: true });
  const [row] = await database.db.select().from(usageRecords);
  expect(row).toMatchObject({ memberId: "ada", model: "large", promptTokens: 12, completionTokens: 2, status: "completed" });
});

test("a model the member may not use is refused before reaching the upstream", async () => {
  const response = await call("key-bob", "/v1/chat/completions", { model: "large", messages: [] });
  expect(response.status).toBe(403);
  expect((await response.json()).error.message).toContain("Request access");
  expect(upstreamCalls).toEqual([]);
});

test("unknown, revoked and inactive-member keys are refused", async () => {
  expect((await call("nope", "/v1/models")).status).toBe(401);
  await database.db.update(inferenceKeys).set({ revokedAt: new Date() }).where(eq(inferenceKeys.memberId, "bob"));
  expect((await call("key-bob", "/v1/models")).status).toBe(401);
  await database.db.update(members).set({ active: false }).where(eq(members.id, "ada"));
  expect((await call("key-ada", "/v1/chat/completions", { model: "main", messages: [] })).status).toBe(401);
});

test("unknown models are 404 and an unreachable upstream is 502 and recorded as failed", async () => {
  expect((await call("key-bob", "/v1/chat/completions", { model: "gpt-4", messages: [] })).status).toBe(404);
  upstreamDown = true;
  expect((await call("key-bob", "/v1/chat/completions", { model: "main", messages: [] })).status).toBe(502);
  expect(await database.db.select({ status: usageRecords.status }).from(usageRecords)).toEqual([{ status: "failed" }]);
});

test("the daily token limit refuses requests once it is used up", async () => {
  limit = 15;
  expect((await call("key-bob", "/v1/chat/completions", { model: "main", messages: [] })).status).toBe(200);
  expect((await call("key-bob", "/v1/chat/completions", { model: "main", messages: [] })).status).toBe(200);
  const third = await call("key-bob", "/v1/chat/completions", { model: "main", messages: [] });
  expect(third.status).toBe(429);
  expect((await call("key-ada", "/v1/chat/completions", { model: "main", messages: [] })).status).toBe(200);
});
