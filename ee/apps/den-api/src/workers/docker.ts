import { request as httpRequest } from "node:http"
import { renderOfflineGPTBootstrapScript, type OfflineGPTBootstrapConfig } from "@offlinegpt-ee/cloud-runtime/bootstrap"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"

/**
 * PROVISIONER_MODE=docker: one workspace container per member on the same
 * Docker host (or Docker-compatible engine) as Den, on an internal network.
 * Used by the air-gapped edition, where no cloud sandbox provider is reachable.
 *
 * Each workspace gets two named volumes (workspace files and engine data), so
 * stopping a workspace never loses a member's work.
 */

const logger = appLogger.child({ component: "docker_provisioner" })

type ProvisionInput = {
  workerId: string
  name: string
  hostToken: string
  clientToken: string
  activityToken: string
}

export type DockerApiResponse = { status: number; body: unknown }
export type DockerApi = (method: string, path: string, body?: unknown) => Promise<DockerApiResponse>

const WORKSPACE_MOUNT = "/workspace"
const DATA_MOUNT = "/persist/offlinegpt"
const WORKER_ENV_PREFIX = "WORKER_ENV_"

export function socketDockerApi(socketPath: string): DockerApi {
  return (method, path, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest({
      socketPath,
      method,
      path: `/v1.43${path}`,
      headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
    }, (res) => {
      let text = ""
      res.setEncoding("utf8")
      res.on("data", (chunk: string) => { text += chunk })
      res.on("end", () => {
        let parsed: unknown = text
        try { parsed = text ? JSON.parse(text) : null } catch { /* plain-text Docker error */ }
        resolve({ status: res.statusCode ?? 0, body: parsed })
      })
    })
    req.on("error", reject)
    req.setTimeout(60_000, () => req.destroy(new Error(`Docker API ${method} ${path} timed out`)))
    if (payload) req.write(payload)
    req.end()
  })
}

function dockerError(action: string, response: DockerApiResponse) {
  const message = typeof response.body === "object" && response.body !== null && "message" in response.body
    ? String(response.body.message)
    : String(response.body)
  return new Error(`Docker ${action} failed (${response.status}): ${message}`)
}

export function dockerWorkerName(workerId: string) {
  const hint = workerId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return `${env.docker.workerNamePrefix}-${hint}`.slice(0, 63)
}

/** Env passed to every workspace: the edition switch plus WORKER_ENV_* settings (prefix removed). */
export function dockerWorkerEnvironment(source: NodeJS.ProcessEnv = process.env): string[] {
  const entries = new Map<string, string>()
  if (env.airgapped) entries.set("OFFLINEGPT_EDITION", "airgapped")
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith(WORKER_ENV_PREFIX) || value === undefined) continue
    const name = key.slice(WORKER_ENV_PREFIX.length)
    if (/^[A-Z_][A-Z0-9_]*$/.test(name)) entries.set(name, value)
  }
  return [...entries].map(([key, value]) => `${key}=${value}`)
}

export function dockerBootstrapConfig(input: ProvisionInput): OfflineGPTBootstrapConfig {
  return {
    workspaceMountPath: WORKSPACE_MOUNT,
    dataMountPath: DATA_MOUNT,
    runtimeWorkspacePath: "/tmp/offlinegpt-workspace",
    runtimeDataPath: "/tmp/offlinegpt-data",
    sidecarDir: "/tmp/offlinegpt-sidecars",
    intervalSeconds: env.daytona.checkpointIntervalSeconds,
    keep: env.daytona.checkpointKeep,
    port: env.docker.workerPort,
    workerId: input.workerId,
    clientToken: input.clientToken,
    hostToken: input.hostToken,
    activityHeartbeat: {
      url: `${env.workerActivityBaseUrl.replace(/\/+$/, "")}/v1/workers/${encodeURIComponent(input.workerId)}/activity-heartbeat`,
      token: input.activityToken,
    },
    runtimeProvider: "docker",
    imageDescription: "OfflineGPT workspace image",
    rebuildHint: "rebuild the workspace image",
  }
}

export function dockerContainerSpec(input: ProvisionInput) {
  const name = dockerWorkerName(input.workerId)
  return {
    Image: env.docker.workerImage,
    Cmd: ["sh", "-lc", renderOfflineGPTBootstrapScript(dockerBootstrapConfig(input))],
    Env: dockerWorkerEnvironment(),
    Labels: {
      "offlinegpt.worker-id": input.workerId,
      "offlinegpt.role": "workspace",
    },
    ExposedPorts: { [`${env.docker.workerPort}/tcp`]: {} },
    HostConfig: {
      NetworkMode: env.docker.network,
      RestartPolicy: { Name: "unless-stopped" },
      SecurityOpt: ["no-new-privileges"],
      ...(env.docker.memoryMb ? { Memory: env.docker.memoryMb * 1024 * 1024 } : {}),
      ...(env.docker.cpus ? { NanoCpus: Math.round(env.docker.cpus * 1e9) } : {}),
      Mounts: [
        { Type: "volume", Source: `${name}-workspace`, Target: WORKSPACE_MOUNT },
        { Type: "volume", Source: `${name}-data`, Target: DATA_MOUNT },
      ],
    },
    NetworkingConfig: { EndpointsConfig: { [env.docker.network]: { Aliases: [name] } } },
  }
}

async function waitForHealthy(url: string, timeoutMs: number, fetchImpl: typeof fetch) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(5000) })
      if (response.ok) return
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error(`Workspace at ${url} did not become healthy within ${Math.round(timeoutMs / 1000)}s`)
}

export async function provisionWorkerOnDocker(
  input: ProvisionInput,
  deps: { api?: DockerApi; fetchImpl?: typeof fetch; healthTimeoutMs?: number } = {},
) {
  if (!env.docker.workerImage) throw new Error("DOCKER_WORKER_IMAGE is required when PROVISIONER_MODE=docker")
  const api = deps.api ?? socketDockerApi(env.docker.socketPath)
  const name = dockerWorkerName(input.workerId)

  // Tokens are baked into the container command, so a re-provision replaces
  // the container. Its volumes, and so the member's files, are kept.
  const existing = await api("GET", `/containers/${name}/json`)
  if (existing.status === 200) {
    const removed = await api("DELETE", `/containers/${name}?force=true`)
    if (removed.status !== 204 && removed.status !== 404) throw dockerError("remove", removed)
  }
  const created = await api("POST", `/containers/create?name=${encodeURIComponent(name)}`, dockerContainerSpec(input))
  if (created.status !== 201) throw dockerError("create", created)
  const started = await api("POST", `/containers/${name}/start`)
  if (started.status !== 204 && started.status !== 304) throw dockerError("start", started)

  const url = `http://${name}:${env.docker.workerPort}`
  await waitForHealthy(url, deps.healthTimeoutMs ?? env.docker.healthTimeoutMs, deps.fetchImpl ?? fetch)
  logger.info("workspace container ready", { worker_id: input.workerId, container: name })
  return { provider: "docker", url, status: "healthy" as const, imageVersion: env.docker.workerImage }
}

/** Stop the workspace container. Volumes stay, so the member's files are kept. */
export async function deprovisionWorkerOnDocker(workerId: string, deps: { api?: DockerApi } = {}) {
  const api = deps.api ?? socketDockerApi(env.docker.socketPath)
  const name = dockerWorkerName(workerId)
  const stopped = await api("POST", `/containers/${name}/stop?t=20`)
  if (stopped.status !== 204 && stopped.status !== 304 && stopped.status !== 404) throw dockerError("stop", stopped)
}

/**
 * What the browser gateway's runtime resolver needs to know about a Docker
 * workspace, shaped like the Daytona sandbox record it already understands: a
 * Docker workspace lives at a fixed internal URL that never expires, so the
 * "signed preview" is just that URL. Missing container → null, which the
 * resolver turns into (re)provisioning.
 */
const DOCKER_URL_VALIDITY_MS = 24 * 60 * 60 * 1000

async function dockerContainerState(workerId: string, api: DockerApi) {
  const inspected = await api("GET", `/containers/${dockerWorkerName(workerId)}/json`)
  if (inspected.status === 404) return null
  if (inspected.status !== 200) throw dockerError("inspect", inspected)
  const state = typeof inspected.body === "object" && inspected.body !== null && "State" in inspected.body ? inspected.body.State : null
  const running = typeof state === "object" && state !== null && "Running" in state && state.Running === true
  return running ? "started" : "stopped"
}

export async function getDockerWorkspaceRecord(workerId: string, deps: { api?: DockerApi } = {}) {
  const state = await dockerContainerState(workerId, deps.api ?? socketDockerApi(env.docker.socketPath))
  if (!state) return null
  const name = dockerWorkerName(workerId)
  return {
    sandbox_id: name,
    signed_preview_url: `http://${name}:${env.docker.workerPort}`,
    signed_preview_url_expires_at: new Date(Date.now() + DOCKER_URL_VALIDITY_MS),
  }
}

export async function inspectDockerWorkspace(workerId: string, deps: { api?: DockerApi } = {}) {
  const state = await dockerContainerState(workerId, deps.api ?? socketDockerApi(env.docker.socketPath))
  return state ? { state } : null
}
