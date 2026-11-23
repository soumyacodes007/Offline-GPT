import assert from "node:assert/strict"
import { test } from "node:test"

process.env.OFFLINEGPT_DEV_MODE = "1"
const { createSelfHostedCatalog, parseConfiguredModels } = await import("../src/model-catalog.js")

test("reads the self-hosted catalog from the upstream and caches it", async () => {
  let calls = 0
  let clock = 0
  const catalog = createSelfHostedCatalog({
    upstreamUrl: "http://vllm.internal:8000/v1",
    apiKey: "k",
    now: () => clock,
    ttlMs: 1000,
    fetchImpl: async (input, init) => {
      calls += 1
      assert.equal(String(input), "http://vllm.internal:8000/v1/models")
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer k")
      return Response.json({ object: "list", data: [{ id: "qwen-small", object: "model" }] })
    },
  })
  assert.deepEqual((await catalog()).map((model) => model.alias), ["qwen-small"])
  await catalog()
  assert.equal(calls, 1)
  clock = 2000
  await catalog()
  assert.equal(calls, 2)
})

test("configured models override discovery", async () => {
  const configured = parseConfiguredModels('[{"alias":"main","upstreamModel":"Qwen/Qwen2.5-0.5B-Instruct","displayName":"Main"}]')
  const catalog = createSelfHostedCatalog({ upstreamUrl: "http://unused", configured, fetchImpl: async () => { throw new Error("must not fetch") } })
  assert.deepEqual(await catalog(), [{ alias: "main", upstreamModel: "Qwen/Qwen2.5-0.5B-Instruct", displayName: "Main", enabled: true, usageFactor: 1 }])
  assert.throws(() => parseConfiguredModels("not json"), /INFERENCE_MODELS/)
})

test("builds the OpenCode catalog for self-hosted models", async () => {
  const { buildOpencodeModelsCatalog } = await import("../src/model-catalog.js")
  const catalog = buildOpencodeModelsCatalog([{ alias: "qwen-small", upstreamModel: "q", displayName: "Qwen small", enabled: true, usageFactor: 1, contextLength: 8192 }], "http://inference:8791/")
  assert.equal(catalog.offlinegpt.api, "http://inference:8791/api/v1")
  assert.equal(catalog.offlinegpt.npm, "@ai-sdk/openai-compatible")
  assert.deepEqual(catalog.offlinegpt.models["qwen-small"], {
    id: "qwen-small", name: "Qwen small", attachment: false, reasoning: false, tool_call: true, temperature: true, open_weights: true,
    modalities: { input: ["text"], output: ["text"] }, limit: { context: 8192, output: 2048 }, cost: { input: 0, output: 0 },
  })
})
