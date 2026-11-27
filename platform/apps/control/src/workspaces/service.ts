import { and, eq, isNull, lt } from "drizzle-orm";
import { inferenceKeys, workspaces, type Database } from "@offlinegpt-platform/db";
import { newId, randomToken, sha256 } from "../crypto";
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

type Row = typeof workspaces.$inferSelect;
export type Workspace = { memberId: string; containerName: string; token: string; status: Row["status"] };

/** OpenCode's global config for a member: one provider that points at the model gateway with the member's own key. */
export function opencodeConfig(settings: WorkspaceSettings, inferenceKey: string): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    provider: {
      offlinegpt: {
        npm: "@ai-sdk/openai-compatible",
        name: "OfflineGPT Models",
        options: { baseURL: settings.modelGatewayUrl, apiKey: inferenceKey },
        models: Object.fromEntries(settings.models.map((model) => [model.alias, { name: model.displayName, limit: { context: model.contextLength, output: Math.min(8192, Math.floor(model.contextLength / 4)) } }])),
      },
    },
    mcp: { offlinegpt: { type: "remote", url: `${settings.controlUrl.replace(/\/+$/, "")}/mcp`, headers: { Authorization: `Bearer ${inferenceKey}` }, enabled: true } },
    ...(settings.models[0] ? { model: `offlinegpt/${settings.models[0].alias}` } : {}),
  });
}

/** Writes the OpenCode config from the environment, then runs the workspace server. */
const START_SCRIPT = [
  "set -eu",
  'mkdir -p "$HOME/.config/opencode"',
  'printf "%s" "$OGP_OPENCODE_CONFIG" > "$HOME/.config/opencode/opencode.json"',
  'unset OGP_OPENCODE_CONFIG',
  `exec offlinegpt-server --host 0.0.0.0 --port ${WORKSPACE_PORT} --token "$OGP_WORKSPACE_TOKEN" --approval auto --workspace /workspace --log-format json`,
].join("\n");

export function createWorkspaceService(db: Database, docker: Docker, settings: WorkspaceSettings, now: () => Date) {
  async function find(memberId: string): Promise<Row | undefined> {
    const [row] = await db.select().from(workspaces).where(eq(workspaces.memberId, memberId)).limit(1);
    return row;
  }

  /** A fresh inference key for the container; the member's previous key stops working. */
  async function issueKey(memberId: string): Promise<string> {
    const key = `ogk_${randomToken(32)}`;
    await db.transaction(async (tx) => {
      await tx.update(inferenceKeys).set({ revokedAt: now() }).where(and(eq(inferenceKeys.memberId, memberId), isNull(inferenceKeys.revokedAt)));
      await tx.insert(inferenceKeys).values({ id: newId("ikey"), memberId, keyHash: sha256(key), prefix: key.slice(0, 10), createdAt: now() });
    });
    return key;
  }

  async function createContainer(memberId: string, containerName: string, token: string) {
    const key = await issueKey(memberId);
    await docker.create({
      name: containerName,
      image: settings.image,
      cmd: ["sh", "-c", START_SCRIPT],
      env: { OGP_WORKSPACE_TOKEN: token, OGP_OPENCODE_CONFIG: opencodeConfig(settings, key) },
      labels: { "offlinegpt.platform": "workspace", "offlinegpt.member": memberId },
      volume: `${containerName}-data`,
      mountPath: "/workspace",
      network: settings.network,
      memoryMb: settings.memoryMb,
      cpus: settings.cpus,
    });
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
      if (state === "missing") await createContainer(memberId, containerName, token);
      if (state !== "running") await docker.start(containerName);
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
