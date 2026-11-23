import { describe, expect, test } from "bun:test"

process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/offlinegpt_test"
process.env.DB_MODE ??= "mysql"
process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
process.env.DEN_BASE_URL ??= "https://offlinegpt.psu.internal"
process.env.PROVISIONER_MODE = "docker"
process.env.DOCKER_WORKER_IMAGE = "registry.psu.internal/offlinegpt-workspace:1"
process.env.DOCKER_WORKER_NETWORK = "offlinegpt-internal"
process.env.WORKER_ENV_OPENCODE_MODELS_URL = "http://inference:8791/models"
process.env.WORKER_ENV_bad = "ignored"

const docker = await import("../src/workers/docker.ts")

type Call = { method: string; path: string; body?: unknown }

function fakeApi(responses: Record<string, number>) {
  const calls: Call[] = []
  const api: import("../src/workers/docker.ts").DockerApi = async (method, path, body) => {
    calls.push({ method, path, body })
    const key = `${method} ${path.split("?")[0]}`
    return { status: responses[key] ?? 404, body: null }
  }
  return { api, calls }
}

const input = { workerId: "wrk_01JZTEST", name: "Asha", hostToken: "host-tok", clientToken: "client-tok", activityToken: "act-tok" }

describe("PROVISIONER_MODE=docker", () => {
  test("creates and starts one workspace container per member on the internal network", async () => {
    const name = docker.dockerWorkerName(input.workerId)
    const { api, calls } = fakeApi({ [`POST /containers/create`]: 201, [`POST /containers/${name}/start`]: 204 })
    const fetchImpl = (async () => new Response("ok")) as unknown as typeof fetch
    const result = await docker.provisionWorkerOnDocker(input, { api, fetchImpl, healthTimeoutMs: 1000 })

    expect(result).toEqual({ provider: "docker", url: `http://${name}:8787`, status: "healthy", imageVersion: "registry.psu.internal/offlinegpt-workspace:1" })
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /containers/${name}/json`,
      `POST /containers/create?name=${name}`,
      `POST /containers/${name}/start`,
    ])
    const spec = calls[1].body as ReturnType<typeof docker.dockerContainerSpec>
    expect(spec.Image).toBe("registry.psu.internal/offlinegpt-workspace:1")
    expect(spec.HostConfig.NetworkMode).toBe("offlinegpt-internal")
    expect(spec.HostConfig.Mounts.map((mount) => mount.Source)).toEqual([`${name}-workspace`, `${name}-data`])
    // WORKER_ENV_* settings reach the workspace with the prefix removed; invalid names are dropped.
    expect(spec.Env).toEqual(["OPENCODE_MODELS_URL=http://inference:8791/models"])
    expect(spec.Cmd[2]).toContain("OFFLINEGPT_TOKEN='client-tok'")
    expect(spec.Cmd[2]).toContain("DEN_RUNTIME_PROVIDER='docker'")
  })

  test("re-provisioning replaces the container but keeps its volumes", async () => {
    const name = docker.dockerWorkerName(input.workerId)
    const { api, calls } = fakeApi({
      [`GET /containers/${name}/json`]: 200,
      [`DELETE /containers/${name}`]: 204,
      [`POST /containers/create`]: 201,
      [`POST /containers/${name}/start`]: 204,
    })
    await docker.provisionWorkerOnDocker(input, { api, fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch, healthTimeoutMs: 1000 })
    expect(calls[1]).toEqual({ method: "DELETE", path: `/containers/${name}?force=true`, body: undefined })
    expect(calls.some((call) => call.path.includes("/volumes"))).toBe(false)
  })

  test("stopping keeps the member's files", async () => {
    const name = docker.dockerWorkerName(input.workerId)
    const { api, calls } = fakeApi({ [`POST /containers/${name}/stop`]: 204 })
    await docker.deprovisionWorkerOnDocker(input.workerId, { api })
    expect(calls).toEqual([{ method: "POST", path: `/containers/${name}/stop?t=20`, body: undefined }])
  })

  test("a Docker failure is reported, not swallowed", async () => {
    const { api } = fakeApi({})
    const failing: typeof api = async (method, path, body) => method === "POST" && path.startsWith("/containers/create")
      ? { status: 404, body: { message: "No such image: registry.psu.internal/offlinegpt-workspace:1" } }
      : api(method, path, body)
    await expect(docker.provisionWorkerOnDocker(input, { api: failing })).rejects.toThrow("Docker create failed (404): No such image")
  })
})
