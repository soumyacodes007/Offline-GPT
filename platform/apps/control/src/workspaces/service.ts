import { and, eq, isNull, lt } from "drizzle-orm";
import { inferenceKeys, workspaces, type Database } from "@offlinegpt-platform/db";
import { newId, randomToken, sha256 } from "../crypto";
import { z } from "zod";
import type { Docker } from "./docker";

export type WorkspaceModel = { alias: string; displayName: string; contextLength: number };

export type WorkspaceSettings = {
  image: string;
  network: string;
  /** Model gateway URL as seen from inside the workspace network, ending in /v1. */
  modelGatewayUrl: string;
  /** Control service URL as seen from inside the workspace network; serves the MCP endpoint. */
  controlUrl: string;
  models: WorkspaceModel[];
  memoryMb: number;
  cpus: number;
  idleMs: number;
};

export const WORKSPACE_PORT = 8787;

const workspaceList = z.object({ items: z.array(z.object({ id: z.string() })) });

type Row = typeof workspaces.$inferSelect;
export type Workspace = { memberId: string; containerName: string; token: string; status: Row["status"] };

/** The member's model provider: the model gateway, with the member's own key. */
export function providerConfig(settings: WorkspaceSettings, inferenceKey: string) {
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "OfflineGPT Models",
    options: { baseURL: settings.modelGatewayUrl, apiKey: inferenceKey },
    models: Object.fromEntries(settings.models.map((model) => [model.alias, { name: model.displayName, limit: { context: model.contextLength, output: Math.min(8192, Math.floor(model.contextLength / 4)) } }])),
  };
}

/** The platform's MCP server (knowledge, skills), called with the member's own key. */
export function mcpConfig(settings: WorkspaceSettings, inferenceKey: string) {
  return { type: "remote", url: `${settings.controlUrl.replace(/\/+$/, "")}/mcp`, headers: { Authorization: `Bearer ${inferenceKey}` }, enabled: true };
}

/** OpenCode's global config for a member: the provider above plus the platform MCP server. */
export function opencodeConfig(settings: WorkspaceSettings, inferenceKey: string): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    provider: { offlinegpt: providerConfig(settings, inferenceKey) },
    mcp: { offlinegpt: mcpConfig(settings, inferenceKey) },
    ...(settings.models[0] ? { model: `offlinegpt/${settings.models[0].alias}` } : {}),
  });
}

/** Writes the OpenCode config from the environment, then runs the workspace server. */
const START_SCRIPT = [
  "set -eu",
  'mkdir -p "$HOME/.config/opencode"',
  'printf "%s" "$OGP_OPENCODE_CONFIG" > "$HOME/.config/opencode/opencode.json"',
  'unset OGP_OPENCODE_CONFIG',
  `exec offlinegpt-server --host 0.0.0.0 --port ${WORKSPACE_PORT} --token "$OGP_WORKSPACE_TOKEN" --host-token "$OGP_HOST_TOKEN" --approval auto --workspace /workspace --log-format json`,
].join("\n");

/** The workspace server's host token, derived from the workspace token so nothing extra is stored. */
export function hostTokenFor(token: string): string {
  return sha256(`host:${token}`);
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function createWorkspaceService(db: Database, docker: Docker, settings: WorkspaceSettings, now: () => Date, fetchImpl: Fetch = fetch, retryDelayMs = 1000) {
  /**
   * Give the workspace server the member's provider. Its engine takes providers
   * from the server's runtime config, not from OpenCode's own config file.
   * Retries while the new container starts.
   */
  /** The engine ignores the config file, so the provider and MCP server go through the workspace server's host API. */
  async function deliverProvider(containerName: string, token: string, key: string): Promise<void> {
    await deliver(containerName, token, "providers", { provider: { offlinegpt: providerConfig(settings, key) } });
    await deliver(containerName, token, "mcp", { mcp: { offlinegpt: mcpConfig(settings, key) } });
  }

  /**
   * The chat engine reloads itself after the config above changes and answers
   * slowly at first. Wait for it (best effort) so the first message isn't sent
   * into a workspace that isn't ready.
   */
  async function warmEngine(containerName: string, token: string): Promise<void> {
    const base = `http://${containerName}:${WORKSPACE_PORT}`;
    const headers = { authorization: `Bearer ${token}` };
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const listed = workspaceList.safeParse(await (await fetchImpl(`${base}/workspaces`, { headers, signal: AbortSignal.timeout(10_000) })).json());
        const id = listed.success ? listed.data.items[0]?.id : undefined;
        if (id && (await fetchImpl(`${base}/workspace/${id}/opencode2/api/session`, { headers, signal: AbortSignal.timeout(10_000) })).ok) return;
      } catch {
        // Not up yet.
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  async function deliver(containerName: string, token: string, part: "providers" | "mcp", body: unknown): Promise<void> {
    const url = `http://${containerName}:${WORKSPACE_PORT}/runtime-config/${part}`;
    let lastError = "not reached";
    for (let attempt = 0; attempt < 90; attempt += 1) {
      try {
        const response = await fetchImpl(url, {
          method: "PATCH",
          headers: { "content-type": "application/json", "x-offlinegpt-host-token": hostTokenFor(token) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) return;
        if (response.status === 404) throw new Error(`the workspace image is too old to accept ${part}; rebuild it`);
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("the workspace image")) throw new Error(`Could not configure the workspace: ${error.message}`);
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    throw new Error(`Could not configure the workspace's ${part}: ${lastError}`);
  }

  async function find(memberId: string): Promise<Row | undefined> {
    const [row] = await db.select().from(workspaces).where(eq(workspaces.memberId, memberId)).limit(1);
    return row;
  }

  /** A fresh inference key for the container; the member's previous key stops working. */
  async function issueKey(memberId: string): Promise<string> {
    const key = `ogk_${randomToken(32)}`;
    await db.transaction(async (tx) => {
      await tx.update(inferenceKeys).set({ revokedAt: now() }).where(and(eq(inferenceKeys.memberId, memberId), eq(inferenceKeys.purpose, "workspace"), isNull(inferenceKeys.revokedAt)));
      await tx.insert(inferenceKeys).values({ id: newId("ikey"), memberId, keyHash: sha256(key), prefix: key.slice(0, 10), purpose: "workspace", createdAt: now() });
    });
    return key;
  }

  async function createContainer(memberId: string, containerName: string, token: string) {
    const key = await issueKey(memberId);
    await docker.create({
      name: containerName,
      image: settings.image,
      cmd: ["sh", "-c", START_SCRIPT],
      // OFFLINEGPT_WEB_ROOT makes the workspace server serve the workspace app itself.
      // OPENCODE_MODELS_URL: the air-gapped engine reads its model catalog from the gateway, never the internet.
      env: { OGP_WORKSPACE_TOKEN: token, OGP_HOST_TOKEN: hostTokenFor(token), OGP_OPENCODE_CONFIG: opencodeConfig(settings, key), OFFLINEGPT_WEB_ROOT: "/opt/offlinegpt/web", ...(settings.models[0] ? { OFFLINEGPT_WEB_DEFAULT_MODEL: `offlinegpt/${settings.models[0].alias}` } : {}), OPENCODE_MODELS_URL: `${settings.modelGatewayUrl.replace(/\/v1\/?$/, "")}/models` },
      labels: { "offlinegpt.platform": "workspace", "offlinegpt.member": memberId },
      volume: `${containerName}-data`,
      mountPath: "/workspace",
      network: settings.network,
      memoryMb: settings.memoryMb,
      cpus: settings.cpus,
    });
    return key;
  }

  return {
    async get(memberId: string): Promise<Workspace | null> {
      const row = await find(memberId);
      return row ? { memberId: row.memberId, containerName: row.containerName, token: row.token, status: row.status } : null;
    },

    /** Create the member's workspace on first use, start it when stopped, and recreate it if its container vanished. */
    async ensure(memberId: string): Promise<Workspace> {
      const existing = await find(memberId);
      const containerName = existing?.containerName ?? `ogp-ws-${sha256(memberId).slice(0, 16)}`;
      const token = existing?.token ?? randomToken(32);
      if (!existing) await db.insert(workspaces).values({ memberId, containerName, token, status: "stopped", createdAt: now(), lastActiveAt: now() });
      const state = await docker.state(containerName);
      const newKey = state === "missing" ? await createContainer(memberId, containerName, token) : null;
      if (state !== "running") await docker.start(containerName);
      if (newKey) {
        await deliverProvider(containerName, token, newKey);
        await warmEngine(containerName, token);
      }
      await db.update(workspaces).set({ status: "running", lastActiveAt: now() }).where(eq(workspaces.memberId, memberId));
      return { memberId, containerName, token, status: "running" };
    },

    async touch(memberId: string): Promise<void> {
      await db.update(workspaces).set({ lastActiveAt: now() }).where(eq(workspaces.memberId, memberId));
    },

    async stop(memberId: string): Promise<void> {
      const row = await find(memberId);
      if (!row) return;
      await docker.stop(row.containerName);
      await db.update(workspaces).set({ status: "stopped" }).where(eq(workspaces.memberId, memberId));
    },

    /** Stop every running workspace nobody has used for the idle period. Returns how many were stopped. */
    async stopIdle(): Promise<number> {
      const cutoff = new Date(now().getTime() - settings.idleMs);
      const idle = await db.select().from(workspaces).where(and(eq(workspaces.status, "running"), lt(workspaces.lastActiveAt, cutoff)));
      for (const row of idle) {
        await docker.stop(row.containerName);
        await db.update(workspaces).set({ status: "stopped" }).where(eq(workspaces.memberId, row.memberId));
      }
      return idle.length;
    },
  };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;
