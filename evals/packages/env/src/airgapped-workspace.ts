import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { SkipError } from "./needs.ts";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const run = promisify(execFile);
const docker = (...args: string[]) => run("docker", args, { maxBuffer: 8 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });

export const AIRGAPPED_WORKSPACE_IMAGE = process.env.OFFLINEGPT_EVAL_WORKSPACE_IMAGE?.trim() || "offlinegpt-workspace:airgapped";

// A streaming OpenAI-compatible stand-in, run from the workspace image itself
// so the internal network never needs another image.
const FAKE_MODEL_SERVER = `
const http = require("node:http");
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (req.url === "/v1/models") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ object: "list", data: [{ id: "main", object: "model", max_model_len: 32768 }] })); }
    if (req.url !== "/v1/chat/completions") { res.statusCode = 404; return res.end("{}"); }
    const stream = JSON.parse(body || "{}").stream === true;
    const chunk = (delta, finish) => ({ id: "c1", object: "chat.completion.chunk", created: 0, model: "main", choices: [{ index: 0, delta, finish_reason: finish }] });
    if (!stream) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ id: "c1", object: "chat.completion", model: "main", choices: [{ index: 0, message: { role: "assistant", content: "OFFLINE" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); }
    res.setHeader("content-type", "text/event-stream");
    res.write("data: " + JSON.stringify(chunk({ role: "assistant", content: "OFFLINE" }, null)) + "\\n\\n");
    res.write("data: " + JSON.stringify({ ...chunk({}, "stop"), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + "\\n\\n");
    res.end("data: [DONE]\\n\\n");
  });
}).listen(8000, "0.0.0.0");
`;

/**
 * One employee workspace exactly as the air-gapped edition runs it: started by
 * den-api's PROVISIONER_MODE=docker code on an internal Docker network that has
 * no route to the internet, next to a model server reachable as `vllm`.
 */
export async function airgappedWorkspace() {
  try {
    await docker("image", "inspect", AIRGAPPED_WORKSPACE_IMAGE);
  } catch {
    throw new SkipError(`Docker image ${AIRGAPPED_WORKSPACE_IMAGE} is missing; build packaging/docker/Dockerfile.workspace-airgapped first`);
  }
  const stack = new AsyncDisposableStack();
  try {
    const suffix = randomBytes(4).toString("hex");
    const network = `offlinegpt-airgap-eval-${suffix}`;
    await docker("network", "create", "--internal", network);
    stack.defer(async () => { await docker("network", "rm", network).catch(() => undefined); });

    const realVllm = process.env.OFFLINEGPT_EVAL_VLLM_CONTAINER?.trim();
    if (realVllm) {
      await docker("network", "connect", "--alias", "vllm", network, realVllm);
      stack.defer(async () => { await docker("network", "disconnect", network, realVllm).catch(() => undefined); });
    } else {
      const fake = `offlinegpt-airgap-eval-model-${suffix}`;
      await docker("run", "-d", "--name", fake, "--network", network, "--network-alias", "vllm", "--entrypoint", "node", AIRGAPPED_WORKSPACE_IMAGE, "-e", FAKE_MODEL_SERVER);
      stack.defer(async () => { await docker("rm", "-f", fake).catch(() => undefined); });
    }

    const workerId = `wrk_01eval${suffix}${"0".repeat(16)}`;
    const hostToken = randomBytes(24).toString("hex");
    const clientToken = randomBytes(24).toString("hex");
    const provisionCode = `
      const { execFileSync } = await import("node:child_process");
      const docker = await import("./src/workers/docker.ts");
      const input = ${JSON.stringify({ workerId, name: "Eval", hostToken, clientToken, activityToken: "eval-activity" })};
      const name = docker.dockerWorkerName(input.workerId);
      const fetchImpl = async (url) => {
        try {
          execFileSync("docker", ["exec", name, "node", "-e", "fetch('" + String(url).replace(/^http:\\/\\/[^/:]+/, "http://127.0.0.1") + "').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { stdio: "ignore" });
          return new Response("ok");
        } catch { return new Response("starting", { status: 503 }); }
      };
      const api = docker.socketDockerApi(process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock");
      const result = await docker.provisionWorkerOnDocker(input, { api, fetchImpl, healthTimeoutMs: 240000 });
      console.log("PROVISIONED " + JSON.stringify({ ...result, container: name }));
    `;
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module", "--eval", provisionCode], {
        cwd: `${root}/ee/apps/den-api`,
        env: {
          ...process.env,
          MSYS_NO_PATHCONV: "1",
          OFFLINEGPT_EDITION: "airgapped",
          DATABASE_URL: "mysql://root:password@127.0.0.1:3306/unused", DB_MODE: "mysql",
          DEN_DB_ENCRYPTION_KEY: "x".repeat(40), BETTER_AUTH_SECRET: "y".repeat(40), DEN_BASE_URL: "https://offlinegpt.psu.internal",
          PROVISIONER_MODE: "docker", DOCKER_WORKER_IMAGE: AIRGAPPED_WORKSPACE_IMAGE, DOCKER_WORKER_NETWORK: network,
          DOCKER_WORKER_NAME_PREFIX: `offlinegpt-airgap-eval-ws-${suffix}`,
          WORKER_ENV_OPENCODE_MODELS_URL: "http://inference:8791/models", WORKER_ACTIVITY_BASE_URL: "http://den-api:8788",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let text = "";
      child.stdout.on("data", (chunk) => { text += String(chunk); });
      child.stderr.on("data", (chunk) => { text += String(chunk); });
      child.once("exit", (code) => code === 0 ? resolve(text) : reject(new Error(`Docker provisioning failed (${code}): ${text.slice(-2000)}`)));
    });
    const line = output.split(/\r?\n/).find((entry) => entry.startsWith("PROVISIONED "));
    if (!line) throw new Error(`Provisioner printed no result: ${output.slice(-2000)}`);
    const provisioned = JSON.parse(line.slice("PROVISIONED ".length)) as { provider: string; url: string; status: string; container: string };
    stack.defer(async () => {
      await docker("rm", "-f", provisioned.container).catch(() => undefined);
      await docker("volume", "rm", `${provisioned.container}-workspace`, `${provisioned.container}-data`).catch(() => undefined);
    });

    /** Runs a Node.js snippet inside the workspace container and returns its stdout. */
    async function inWorkspace(code: string, timeoutMs = 180_000) {
      const { stdout } = await run("docker", ["exec", provisioned.container, "node", "-e", code], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
      return stdout.trim();
    }

    return {
      network, provisioned, hostToken, clientToken, inWorkspace,
      model: realVllm ? "vllm" as const : "stand-in" as const,
      async networkIsInternal() {
        const { stdout } = await docker("network", "inspect", network, "--format", "{{.Internal}}");
        return stdout.trim() === "true";
      },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}
