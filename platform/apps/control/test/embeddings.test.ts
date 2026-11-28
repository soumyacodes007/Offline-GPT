import { afterEach, expect, test } from "bun:test";
import { createHarness, json, sessionFrom, type Harness } from "./harness";

const EMBEDDINGS = "http://embedder.internal.test/v1";
/** Words that mean the same thing share a dimension, like a real embedding model would place them close together. */
const CONCEPTS = [["leave", "vacation", "holiday", "time off"], ["salary", "pay", "compensation", "wage"], ["laptop", "computer", "device"]];
let embedderUp = true;
let embedCalls = 0;

function embed(text: string): number[] {
  const lower = text.toLowerCase();
  return [...CONCEPTS.map((words) => words.filter((word) => lower.includes(word)).length), 0.01];
}

async function embedder(input: string | URL | Request, init?: RequestInit): Promise<Response | null> {
  if ((input instanceof Request ? input.url : input.toString()) !== `${EMBEDDINGS}/embeddings`) return null;
  embedCalls += 1;
  if (!embedderUp) return new Response("down", { status: 503 });
  const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
  return Response.json({ data: (body.input as string[]).map((text, index) => ({ index, embedding: embed(text) })) });
}

let h: Harness;
afterEach(async () => {
  await h.close();
  embedderUp = true;
  embedCalls = 0;
});

const HANDBOOK = "# Annual leave\nEveryone gets 24 days of annual leave.\n\n## Salary bands\nBand A pays 40,000.\n\n## Laptops\nIT replaces laptops every three years.";

async function setup() {
  h = await createHarness({ embeddingsUrl: EMBEDDINGS, route: embedder });
  const owner = await h.setupOwner();
  const scim = String((await json(await h.call("POST", "/v1/settings/scim-token", { token: owner }))).token);
  await h.call("POST", "/scim/v2/Users", { scim, body: { userName: "ada@example.test" } });
  const ada = sessionFrom(await h.oidcSignIn({ sub: "a", email: "ada@example.test", name: "Ada" }));
  return { owner, ada };
}

const upload = (owner: string) => h.call("POST", "/v1/knowledge/documents", { token: owner, body: { path: "policies/handbook", title: "Handbook", content: HANDBOOK, audience: [{ type: "role", id: "member" }] } });
const search = async (token: string, query: string): Promise<string[]> => ((await json(await h.call("POST", "/v1/knowledge/search", { token, body: { query } }))).results as Array<{ heading: string }>).map((hit) => hit.heading);

test("meaning-based search finds sections that share no words with the question", async () => {
  const { owner, ada } = await setup();
  const uploaded = await json(await upload(owner));
  expect((uploaded.document as { embedded: boolean }).embedded).toBe(true);
  // "vacation" appears nowhere in the handbook; keyword search alone finds nothing.
  expect(await search(ada, "how many vacation days")).toEqual(["Annual leave"]);
  expect((await search(ada, "what is my pay"))[0]).toBe("Salary bands");
  // Exact words still work.
  expect((await search(ada, "laptops"))[0]).toBe("Laptops");
});

test("permissions still apply to meaning-based results", async () => {
  const { owner, ada } = await setup();
  const document = (await json(await upload(owner))).document as { id: string };
  const detail = await json(await h.call("GET", `/v1/knowledge/documents/${document.id}`, { token: owner }));
  const salary = (detail.sections as Array<{ id: string; heading: string }>).find((section) => section.heading === "Salary bands");
  await h.call("PATCH", `/v1/knowledge/sections/${salary?.id ?? ""}`, { token: owner, body: { sensitivity: "restricted" } });
  expect(await search(ada, "what is my pay")).not.toContain("Salary bands");
});

test("when the embeddings model is down, upload and search still work by keyword, and a re-index catches up", async () => {
  const { owner, ada } = await setup();
  embedderUp = false;
  const uploaded = await upload(owner);
  expect(uploaded.status).toBe(201);
  expect(((await json(uploaded)).document as { embedded: boolean }).embedded).toBe(false);
  expect(await search(ada, "annual leave")).toEqual(["Annual leave"]);
  expect(await search(ada, "vacation")).toEqual([]);

  embedderUp = true;
  const reindexed = await h.call("POST", "/v1/knowledge/reindex", { token: owner, body: {} });
  expect((await json(reindexed)).embedded).toBe(3);
  expect(await search(ada, "vacation")).toEqual(["Annual leave"]);
  const calls = embedCalls;
  // Nothing is missing now, so a plain re-index embeds nothing.
  expect((await json(await h.call("POST", "/v1/knowledge/reindex", { token: owner, body: {} }))).embedded).toBe(0);
  expect(embedCalls).toBe(calls);
  expect((await json(await h.call("POST", "/v1/knowledge/reindex", { token: owner, body: { all: true } }))).embedded).toBe(3);
});
