import { expect } from "vitest";
import { needs, test } from "@offlinegpt/testkit";
import { airgappedInference, airgappedInferenceRefusal } from "@offlinegpt/env";

type ModelList = { data: Array<{ id: string }> };

test("air-gapped inference serves self-hosted models under Den access policy", { timeout: 300000 }, async ({ place, evidence }) => {
  needs({ placement: "local" });
  await using world = await airgappedInference(place);
  const claim = (name: string, detail: string) => evidence.recordAssertionEvidence(name, detail, true);
  const it = await world.employee("IT");
  const finance = await world.employee("Finance");
  const call = (key: string, path: string, body?: Record<string, unknown>, headers: Record<string, string> = {}) => fetch(`${world.url}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  const models = async (key: string) => ((await (await call(key, "/api/v1/models")).json()) as ModelList).data.map((model) => model.id).sort();

  // With no rules every self-hosted model is open to the org.
  const served = await models(finance.key);
  expect(served.length).toBeGreaterThan(0);
  const [main, coder = main] = world.upstream.kind === "fake" ? ["main", "coder"] : [served[0], served[0]];
  expect(served).toContain(main);
  claim("The gateway lists the self-hosted upstream's models", `GET /api/v1/models on the air-gapped gateway returned ${served.join(", ")} from ${world.upstream.kind === "vllm" ? "a real vLLM server" : "the OpenAI-compatible stand-in"}.`);

  // OpenCode's model catalog for workspaces comes from the same gateway.
  const catalog = await (await fetch(`${world.url}/models/api.json`)).json() as { offlinegpt: { api: string; npm: string; models: Record<string, unknown> } };
  expect(catalog.offlinegpt.api).toBe(`${world.url}/api/v1`);
  expect(catalog.offlinegpt.npm).toBe("@ai-sdk/openai-compatible");
  expect(Object.keys(catalog.offlinegpt.models).sort()).toEqual(served);
  claim("Workspaces get an internal model catalog", "GET /models/api.json lists the same self-hosted models under the offlinegpt provider, pointing at the internal gateway rather than a public catalog.");

  // Only IT may use the coder model: an allow rule restricts it to IT's team.
  await world.addRule({ resourceId: coder, principalKind: "team", principalId: it.teamId, effect: "allow" });
  if (coder !== main) {
    expect(await models(finance.key)).toEqual(served.filter((model) => model !== coder));
    expect(await models(it.key)).toEqual(served);
  }
  const refused = await call(finance.key, "/api/v1/chat/completions", { model: coder, messages: [{ role: "user", content: "hello" }], max_tokens: 8 });
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("model_not_allowed");
  const audit = await world.auditActions();
  expect(audit).toContainEqual({ action: "access_policy.denied", payload: expect.objectContaining({ memberId: finance.memberId, resourceKind: "model", resourceId: coder, via: "restricted", surface: "inference" }) });
  claim("A restricted model is refused and audited", `After an allow rule for IT's team on "${coder}", the Finance employee got 403 model_not_allowed and an access_policy.denied audit row (via restricted) was written.`);

  const answered = await call(it.key, "/api/v1/chat/completions", { model: coder, messages: [{ role: "user", content: "Reply with one word: ready" }], max_tokens: 16 }, { "x-offlinegpt-session-id": "ses_airgap_1" });
  expect(answered.status).toBe(200);
  const completion = await answered.json() as { choices: Array<{ message: { content: string } }> };
  expect(completion.choices[0]?.message.content.length).toBeGreaterThan(0);
  if (world.upstream.requests) {
    const forwarded = world.upstream.requests.find((request) => request.path === "/v1/chat/completions");
    expect(forwarded?.sessionId).toBe("ses_airgap_1");
    expect(forwarded?.body).not.toHaveProperty("trace");
  }
  claim("A permitted employee is answered by the self-hosted model", `The IT employee's chat completion on "${coder}" returned 200 with text from ${world.upstream.kind === "vllm" ? "vLLM" : "the upstream"}: ${JSON.stringify(completion.choices[0]?.message.content.slice(0, 60))}.`);

  // Deny wins over the team allow for one IT member.
  await world.addRule({ resourceId: coder, principalKind: "member", principalId: it.memberId, effect: "deny" });
  const denied = await call(it.key, "/api/v1/chat/completions", { model: coder, messages: [{ role: "user", content: "hello" }], max_tokens: 8 });
  expect(denied.status).toBe(403);
  claim("An explicit deny overrides the team allow", "A member-level deny rule on the same model made the IT employee's request fail with 403 even though their team is allowed.");

  // A leaver loses model access at once.
  await world.removeMember(finance.memberId);
  const left = await call(finance.key, "/api/v1/chat/completions", { model: main, messages: [{ role: "user", content: "hello" }], max_tokens: 8 });
  expect(left.status).toBe(401);
  expect(((await left.json()) as { error: { code: string } }).error.code).toBe("invalid_api_key");
  claim("A member who left loses access immediately", "Marking the Finance member removed made their still-active inference key fail with 401 invalid_api_key on the very next request.");
});

test("the air-gapped inference service refuses public upstreams at startup", { timeout: 120000 }, async ({ evidence }) => {
  needs({ placement: "local" });
  const openRouter = await airgappedInferenceRefusal({ OPENROUTER_UPSTREAM_URL: "https://openrouter.ai/api/v1", INFERENCE_UPSTREAM_URL: "http://vllm:8000/v1", INFERENCE_PROXY_BASE_URL: "http://inference:8791" });
  expect(openRouter.code).not.toBe(0);
  expect(openRouter.output).toContain("does not allow OPENROUTER_UPSTREAM_URL");
  const missing = await airgappedInferenceRefusal({});
  expect(missing.code).not.toBe(0);
  expect(missing.output).toContain("requires INFERENCE_UPSTREAM_URL");
  evidence.recordAssertionEvidence("Public upstreams fail at boot", "With OFFLINEGPT_EDITION=airgapped the inference service exits when OPENROUTER_UPSTREAM_URL is set or no self-hosted INFERENCE_UPSTREAM_URL is given.", true);
});
