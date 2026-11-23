import { expect } from "vitest";
import { needs, test } from "@offlinegpt/testkit";
import { airgappedWorkspace } from "@offlinegpt/env";

type Json = Record<string, unknown>;

test("an employee workspace runs the agent offline on a self-hosted model", { timeout: 600000 }, async ({ evidence }) => {
  needs({ placement: "local" });
  await using world = await airgappedWorkspace();
  const claim = (name: string, detail: string) => evidence.recordAssertionEvidence(name, detail, true);
  const json = async (code: string) => JSON.parse(await world.inWorkspace(code)) as Json;
  const host = JSON.stringify({ "X-OfflineGPT-Host-Token": world.hostToken, "content-type": "application/json", accept: "application/json" });
  const client = JSON.stringify({ authorization: `Bearer ${world.clientToken}`, "content-type": "application/json" });

  // Den's Docker provisioner started the workspace on an internal network.
  expect(world.provisioned).toMatchObject({ provider: "docker", status: "healthy" });
  expect(await world.networkIsInternal()).toBe(true);
  const engine = await json(`fetch("http://127.0.0.1:8787/experimental/engine-v2-preview/status",{headers:${client}}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))`);
  expect(engine).toMatchObject({ enabled: true, chatRouting: true, running: true, version: "2.3.2", binSource: "env" });
  claim("Den provisions a workspace that runs the bundled engine", `PROVISIONER_MODE=docker started ${world.provisioned.container} on internal network ${world.network}; it serves chats on OpenCode ${String(engine.version)} from the image (binSource=env), with nothing downloaded.`);

  // The internet is unreachable; the model server is reachable.
  const egress = await json(`Promise.all([
    fetch("https://github.com",{signal:AbortSignal.timeout(8000)}).then(()=>"reached").catch(e=>e.cause?.code??e.message),
    fetch("http://1.1.1.1",{signal:AbortSignal.timeout(8000)}).then(()=>"reached").catch(e=>e.cause?.code??e.message),
    fetch("http://vllm:8000/v1/models").then(r=>r.json()).then(j=>j.data.map(m=>m.id)),
  ]).then(([dns, ip, models])=>console.log(JSON.stringify({ dns, ip, models })))`);
  expect(egress.dns).not.toBe("reached");
  expect(egress.ip).not.toBe("reached");
  expect(egress.models).toContain("main");
  claim("The workspace cannot reach the internet but reaches the model", `From inside the workspace, https://github.com failed (${String(egress.dns)}) and http://1.1.1.1 failed (${String(egress.ip)}), while http://vllm:8000/v1/models listed ${JSON.stringify(egress.models)}.`);

  // Den-style provider materialization succeeds on a v2-only workspace.
  const materialized = await json(`(async () => {
    const env = await fetch("http://127.0.0.1:8787/env",{method:"PUT",headers:${host},body:JSON.stringify({entries:[{key:"OFFLINEGPT_API_KEY",value:"internal"}]})});
    const patch = await fetch("http://127.0.0.1:8787/runtime-config/providers",{method:"PATCH",headers:${host},body:JSON.stringify({provider:{offlinegpt:{
      name:"OfflineGPT Models",npm:"@ai-sdk/openai-compatible",env:["OFFLINEGPT_API_KEY"],api:"http://vllm:8000/v1",options:{baseURL:"http://vllm:8000/v1"},
      models:{main:{name:"Self-hosted main",tool_call:true,limit:{context:32768,output:1024},modalities:{input:["text"],output:["text"]}}}}}})});
    console.log(JSON.stringify({ env: env.status, patch: patch.status, body: (await patch.text()).slice(0, 300) }));
  })()`);
  expect(materialized.env).toBe(200);
  expect(materialized.patch, String(materialized.body)).toBe(200);
  claim("Den's provider delivery succeeds on a v2-only workspace", "PUT /env and PATCH /runtime-config/providers, the calls Den makes to deliver a member's models, both returned 200 on a workspace with no v1 engine.");

  // The agent answers from the self-hosted model.
  const chat = await json(`(async () => {
    const call = async (path, init = {}) => { const r = await fetch("http://127.0.0.1:8787" + path, { headers: ${client}, ...init }); const t = await r.text(); let j = null; try { j = JSON.parse(t) } catch {} return { status: r.status, data: j && typeof j === "object" && "data" in j ? j.data : j }; };
    for (let i = 0; i < 40; i++) { const s = (await call("/experimental/engine-v2-preview/status")).data; if (s?.catalogModelIds?.includes("main")) break; await new Promise(r => setTimeout(r, 500)); }
    const ws = (await call("/workspaces")).data.items[0];
    const base = "/workspace/" + ws.id + "/opencode2";
    const session = (await call(base + "/api/session", { method: "POST", body: JSON.stringify({ title: "Air-gap journey", location: { directory: ws.path } }) })).data;
    const model = await call(base + "/api/session/" + session.id + "/model", { method: "POST", body: JSON.stringify({ model: { providerID: "offlinegpt", id: "main" } }) });
    const prompt = await call(base + "/api/session/" + session.id + "/prompt", { method: "POST", body: JSON.stringify({ text: "Reply with exactly one word: OFFLINE" }) });
    let reply = "";
    for (let i = 0; i < 120 && !reply; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const messages = (await call(base + "/api/session/" + session.id + "/message")).data;
      for (const m of Array.isArray(messages) ? messages : []) {
        if ((m.role ?? m.info?.role ?? m.type) !== "assistant") continue;
        const text = (m.parts ?? m.content ?? []).filter(p => p.type === "text").map(p => p.text).join("").trim();
        if (text) reply = text;
      }
    }
    const status = (await call("/experimental/engine-v2-preview/status")).data;
    const messages = reply ? null : (await call(base + "/api/session/" + session.id + "/message")).data;
    console.log(JSON.stringify({ model: model.status, prompt: prompt.status, reply, ...(reply ? {} : { status, messages: JSON.stringify(messages).slice(0, 1500) }) }));
  })()`);
  expect(chat.model).toBeLessThan(300);
  expect(chat.prompt).toBeLessThan(300);
  expect(String(chat.reply).toUpperCase(), JSON.stringify(chat).slice(0, 2000)).toContain("OFFLINE");
  claim("The agent answers from the self-hosted model", `A chat in the workspace on offlinegpt/main (${world.model === "vllm" ? "real vLLM" : "the OpenAI-compatible stand-in"}) replied ${JSON.stringify(chat.reply)} with the internet unreachable.`);
});
