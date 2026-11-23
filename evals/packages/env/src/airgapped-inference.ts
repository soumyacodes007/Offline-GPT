import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createConnection } from "mysql2/promise";
import { allocateFreePort } from "@offlinegpt/cdp";
import type { Place } from "./place.ts";
import { ephemeralDatabaseName, localMysqlIsRunning } from "./place.ts";
import { SkipError } from "./needs.ts";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const encryptionSecret = "local-dev-db-encryption-key-please-change-1234567890";
const exec = promisify(execFile);
const id = (prefix: string) => `${prefix}_0${randomBytes(16).toString("hex").slice(0, 25)}`;

type UpstreamRequest = { path: string; authorization: string | null; sessionId: string | null; body: Record<string, unknown> | null };

async function readBody(request: IncomingMessage) {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text;
}

/**
 * An OpenAI-compatible stand-in for vLLM with two served models. Used when
 * OFFLINEGPT_EVAL_VLLM_URL does not name a real vLLM server.
 */
async function startFakeVllm(models: string[]) {
  const requests: UpstreamRequest[] = [];
  const server = createServer(async (request, response) => {
    const path = request.url ?? "/";
    const text = await readBody(request);
    const body = text ? JSON.parse(text) as Record<string, unknown> : null;
    requests.push({ path, authorization: request.headers.authorization ?? null, sessionId: typeof request.headers["x-session-id"] === "string" ? request.headers["x-session-id"] : null, body });
    response.setHeader("content-type", "application/json");
    if (path === "/v1/models") {
      response.end(JSON.stringify({ object: "list", data: models.map((model) => ({ id: model, object: "model", max_model_len: 8192 })) }));
      return;
    }
    if (path === "/v1/chat/completions") {
      response.end(JSON.stringify({ id: "cmpl-1", object: "chat.completion", model: body?.model, choices: [{ index: 0, message: { role: "assistant", content: `answered by ${String(body?.model)}` }, finish_reason: "stop" }] }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    async [Symbol.asyncDispose]() { await new Promise((resolve) => server.close(resolve)); },
  };
}

/**
 * The air-gapped inference path, end to end on real services: the inference
 * gateway in OFFLINEGPT_EDITION=airgapped forwarding to a self-hosted
 * OpenAI-compatible upstream, with Den's MySQL holding two employees in
 * different teams and Den access policy rules.
 */
export async function airgappedInference(place: Place) {
  if (place.kind !== "local") throw new SkipError("air-gapped inference fixture requires a local MySQL service");
  if (!await localMysqlIsRunning()) throw new SkipError("MySQL is not reachable at OFFLINEGPT_EVAL_MYSQL_URL or the default local port");
  const stack = new AsyncDisposableStack();
  try {
    const database = stack.use(await place.db(ephemeralDatabaseName("airgap_eval")));
    await exec(process.execPath, ["--import", "tsx", "node_modules/drizzle-kit/bin.cjs", "push", "--force", "--config", "drizzle.config.ts"], {
      cwd: `${root}/ee/packages/den-db`, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, DATABASE_URL: database.url, DEN_DB_ENCRYPTION_KEY: encryptionSecret },
    });
    const sql = await createConnection({ uri: database.url, timezone: "Z" });
    stack.defer(() => sql.end());

    const realVllm = process.env.OFFLINEGPT_EVAL_VLLM_URL?.trim().replace(/\/+$/, "");
    const fake = realVllm ? null : stack.use(await startFakeVllm(["main", "coder"]));
    const upstreamUrl = realVllm ?? fake?.url ?? "";

    const port = await allocateFreePort();
    const url = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", "src/server.ts"], {
      cwd: `${root}/ee/apps/inference`, stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot, NODE_ENV: "test",
        OFFLINEGPT_EDITION: "airgapped",
        PORT: String(port), DB_MODE: "mysql", DATABASE_URL: database.url, DEN_DB_ENCRYPTION_KEY: encryptionSecret,
        INFERENCE_UPSTREAM_URL: upstreamUrl, INFERENCE_PROXY_BASE_URL: url,
        INFERENCE_WEBHOOK_SECRET: "fixture-webhook-secret",
      },
    });
    let logs = "";
    child.stdout?.on("data", (chunk) => { logs += String(chunk); });
    child.stderr?.on("data", (chunk) => { logs += String(chunk); });
    stack.defer(async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    });
    const deadline = Date.now() + 60_000;
    while (!await fetch(`${url}/health`).then((response) => response.ok).catch(() => false)) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Air-gapped inference failed to start: ${logs.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const organizationId = id("org");
    await sql.execute("INSERT INTO organization (id,name,slug,metadata) VALUES (?,?,?,?)", [organizationId, "Air-gapped PSU", organizationId, JSON.stringify({ inference: { enabled: true, tier: "tier1" } })]);
    for (const window of ["five_hour", "weekly", "monthly"]) {
      await sql.execute("INSERT INTO inference_org_limit_policies (id,organization_id,window_type,reset_strategy,anchor_at) VALUES (?,?,?,'activity_based',?)", [id("iolp"), organizationId, window, new Date()]);
    }
    const adminUserId = id("usr");
    await sql.execute("INSERT INTO user (id,name,email,email_verified) VALUES (?,?,?,1)", [adminUserId, "Admin", `${adminUserId}@psu.test`]);

    async function employee(team: string) {
      const userId = id("usr");
      const memberId = id("om");
      const teamId = id("tem");
      const key = `ow_inf_${randomBytes(32).toString("base64url")}`;
      await sql.execute("INSERT INTO user (id,name,email,email_verified) VALUES (?,?,?,1)", [userId, team, `${userId}@psu.test`]);
      await sql.execute("INSERT INTO member (id,organization_id,user_id,role) VALUES (?,?,?,'member')", [memberId, organizationId, userId]);
      await sql.execute("INSERT INTO team (id,name,organization_id) VALUES (?,?,?)", [teamId, team, organizationId]);
      await sql.execute("INSERT INTO team_member (id,team_id,org_membership_id,user_id) VALUES (?,?,?,?)", [id("tmb"), teamId, memberId, userId]);
      await sql.execute("INSERT INTO inference_keys (id,organization_id,org_membership_id,key_hash,status) VALUES (?,?,?,?,'active')", [id("ink"), organizationId, memberId, createHash("sha256").update(key).digest("hex")]);
      return { userId, memberId, teamId, key };
    }

    return {
      url,
      upstream: realVllm ? { kind: "vllm" as const, url: realVllm, requests: null } : { kind: "fake" as const, url: upstreamUrl, requests: fake?.requests ?? [] },
      organizationId,
      employee,
      logs: () => logs,
      async addRule(rule: { resourceId: string; principalKind: "member" | "team" | "role" | "org"; principalId: string; effect: "allow" | "deny"; expiresAt?: Date }) {
        await sql.execute(
          "INSERT INTO access_policy_rule (id,organization_id,resource_kind,resource_id,principal_kind,principal_id,effect,expires_at,created_by_org_membership_id) VALUES (?,?,'model',?,?,?,?,?,?)",
          [id("apr"), organizationId, rule.resourceId, rule.principalKind, rule.principalId, rule.effect, rule.expiresAt ?? null, id("om")],
        );
      },
      async removeMember(memberId: string) {
        await sql.execute("UPDATE member SET removed_at=? WHERE id=?", [new Date(), memberId]);
      },
      async auditActions() {
        const [rows] = await sql.query("SELECT action, payload FROM audit_event WHERE org_id=? ORDER BY created_at", [organizationId]);
        return (rows as Array<{ action: string; payload: unknown }>).map((row) => ({ action: row.action, payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload }));
      },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}

/** Starts the inference service in the air-gapped edition with a forbidden setting and returns its exit output. */
export async function airgappedInferenceRefusal(extraEnv: Record<string, string>) {
  const port = await allocateFreePort();
  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", "src/server.ts"], {
    cwd: `${root}/ee/apps/inference`, stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot, NODE_ENV: "test",
      OFFLINEGPT_EDITION: "airgapped", PORT: String(port), DB_MODE: "mysql",
      DATABASE_URL: "mysql://root:password@127.0.0.1:3306/unused", DEN_DB_ENCRYPTION_KEY: encryptionSecret,
      INFERENCE_WEBHOOK_SECRET: "fixture-webhook-secret", ...extraEnv,
    },
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, 30_000);
    child.once("exit", (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });
  return { code, output };
}
