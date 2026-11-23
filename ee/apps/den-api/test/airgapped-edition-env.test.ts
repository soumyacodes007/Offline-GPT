import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const denApiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function probe(overrides: Record<string, string>) {
  const result = spawnSync(process.execPath, ["--conditions", "development", "--eval", `
    const { env } = await import("./src/env.ts")
    const { resolveOfflineGPTWebAccess } = await import("./src/offlinegpt-web-access.ts")
    const { dockerWorkerEnvironment } = await import("./src/workers/docker.ts")
    console.log(JSON.stringify({
      edition: env.edition,
      orgMode: env.orgMode,
      offlinegptWebEnabled: env.offlinegptWebEnabled,
      passwordBreachScreeningEnabled: env.passwordBreachScreeningEnabled,
      desktopReleasesMode: env.desktopReleasesMode,
      provisionerMode: env.provisionerMode,
      webAccess: resolveOfflineGPTWebAccess({ deploymentAvailable: true, hasEligibleSubscription: false, complimentaryAccess: false }).hasAccess,
      workspaceEnv: dockerWorkerEnvironment({}),
    }))
  `], {
    cwd: denApiRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      DATABASE_URL: "mysql://root:password@127.0.0.1:3306/offlinegpt_test",
      DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY: "x".repeat(32),
      BETTER_AUTH_SECRET: "y".repeat(32),
      DEN_BASE_URL: "https://offlinegpt.psu.internal",
      OFFLINEGPT_DEV_MODE: "0",
      ...overrides,
    },
  })
  return { status: result.status, stderr: result.stderr, value: result.status === 0 ? JSON.parse(result.stdout) : null }
}

describe("OFFLINEGPT_EDITION=airgapped", () => {
  test("turns off public defaults and includes web access", () => {
    const result = probe({ OFFLINEGPT_EDITION: "airgapped", PROVISIONER_MODE: "docker", DOCKER_WORKER_IMAGE: "offlinegpt-workspace:airgapped", DOCKER_WORKER_NETWORK: "offlinegpt-internal" })
    expect(result.stderr).toBe("")
    expect(result.value).toEqual({
      edition: "airgapped",
      orgMode: "single_org",
      offlinegptWebEnabled: true,
      passwordBreachScreeningEnabled: false,
      desktopReleasesMode: "static",
      provisionerMode: "docker",
      webAccess: true,
      // Every workspace container is told it runs in the air-gapped edition.
      workspaceEnv: ["OFFLINEGPT_EDITION=airgapped"],
    })
  })

  test("hosted defaults are unchanged", () => {
    const result = probe({ PROVISIONER_MODE: "stub" })
    expect(result.value).toEqual({
      edition: "hosted",
      orgMode: "single_org",
      offlinegptWebEnabled: false,
      passwordBreachScreeningEnabled: true,
      desktopReleasesMode: "github",
      provisionerMode: "stub",
      webAccess: false,
      workspaceEnv: [],
    })
  })

  test("the Docker provisioner needs an image and a network", () => {
    const result = probe({ OFFLINEGPT_EDITION: "airgapped", PROVISIONER_MODE: "docker" })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("DOCKER_WORKER_IMAGE is required when PROVISIONER_MODE=docker")
  })

  for (const [name, overrides, message] of [
    ["a public service key", { STRIPE_SECRET_KEY: "sk_live_x", RESEND_API_KEY: "re_x" }, "does not allow STRIPE_SECRET_KEY, RESEND_API_KEY"],
    ["a cloud provisioner", { PROVISIONER_MODE: "daytona", DAYTONA_API_KEY: "d" }, "does not allow DAYTONA_API_KEY"],
    ["multi-org mode", { DEN_ORG_MODE: "multi_org" }, "DEN_ORG_MODE must be single_org"],
    ["GitHub desktop releases", { DEN_DESKTOP_RELEASES_MODE: "github" }, "cannot read desktop releases from GitHub"],
    ["breach screening", { DEN_PASSWORD_BREACH_SCREENING_ENABLED: "true" }, "cannot screen passwords"],
  ] as const) {
    test(`refuses to start with ${name}`, () => {
      const result = probe({ OFFLINEGPT_EDITION: "airgapped", ...overrides })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(message)
    })
  }
})
