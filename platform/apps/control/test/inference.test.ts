import { afterEach, beforeEach, expect, test } from "bun:test";
import { inferenceKeys, usageRecords } from "@offlinegpt-platform/db";
import { createHarness, json, type Harness } from "./harness";

let h: Harness;
let owner: string;
beforeEach(async () => {
  h = await createHarness();
  owner = await h.setupOwner();
});
afterEach(async () => {
  await h.close();
});

test("issuing a new inference key revokes the previous one", async () => {
  const first = await json(await h.call("POST", "/v1/me/inference-key", { token: owner }));
  const second = await json(await h.call("POST", "/v1/me/inference-key", { token: owner }));
  expect(String(first.key)).toStartWith("ogk_");
  expect(first.key).not.toBe(second.key);
  const keys = await h.db.select().from(inferenceKeys);
  expect(keys.filter((key) => key.revokedAt === null)).toHaveLength(1);
  expect(JSON.stringify(keys)).not.toContain(String(second.key));
});

test("admins see usage per member and model", async () => {
  const me = await json(await h.call("GET", "/v1/me", { token: owner }));
  const memberId = String(me.id);
  await h.db.insert(usageRecords).values([
    { memberId, model: "main", promptTokens: 10, completionTokens: 5, status: "completed" },
    { memberId, model: "main", promptTokens: 4, completionTokens: null, status: "failed" },
  ]);
  const report = await json(await h.call("GET", "/v1/usage?days=1", { token: owner }));
  expect(report.usage).toEqual([{ memberId, email: "owner@example.test", model: "main", calls: 2, failed: 1, promptTokens: 14, completionTokens: 5 }]);
});
