import { z } from "zod";
import type { WorkspaceSettings } from "./workspaces/service";

const optional = z.string().trim().min(1).optional();

const envSchema = z.object({
  DATABASE_URL: z.string().trim().min(1),
  PUBLIC_URL: z.url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(8790),
  OWNER_EMAIL: z.email(),
  SETUP_CODE: z.string().min(16, "SETUP_CODE must be at least 16 characters"),
  SESSION_HOURS: z.coerce.number().positive().max(24 * 30).default(12),
  OIDC_ISSUER: z.url().optional(),
  OIDC_CLIENT_ID: optional,
  OIDC_CLIENT_SECRET: optional,
  OIDC_JIT: z.enum(["0", "1"]).default("0"),
  WORKSPACE_IMAGE: optional,
  WORKSPACE_NETWORK: optional,
  MODEL_GATEWAY_URL: z.url().optional(),
  MODELS: optional,
  DOCKER_URL: z.string().default("unix:///var/run/docker.sock"),
  WORKSPACE_MEMORY_MB: z.coerce.number().int().min(512).default(4096),
  WORKSPACE_CPUS: z.coerce.number().positive().max(64).default(2),
  WORKSPACE_IDLE_MINUTES: z.coerce.number().int().min(5).default(60),
});

const workspaceModelsSchema = z.array(z.object({ alias: z.string().min(1), displayName: z.string().min(1), contextLength: z.number().int().positive() })).min(1);

export type OidcConfig = { issuer: string; clientId: string; clientSecret: string; jit: boolean };

export type WorkspaceConfig = WorkspaceSettings & { dockerUrl: string };

export type Config = {
  databaseUrl: string;
  publicUrl: URL;
  port: number;
  ownerEmail: string;
  setupCode: string;
  sessionMs: number;
  oidc: OidcConfig | null;
  /** Null when this deployment does not run per-member workspaces. */
  workspaces: WorkspaceConfig | null;
};

export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = envSchema.parse(env);
  const oidcParts = [parsed.OIDC_ISSUER, parsed.OIDC_CLIENT_ID, parsed.OIDC_CLIENT_SECRET];
  if (oidcParts.some(Boolean) && !oidcParts.every(Boolean)) {
    throw new Error("Set all of OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET, or none of them.");
  }
  return {
    databaseUrl: parsed.DATABASE_URL,
    publicUrl: new URL(parsed.PUBLIC_URL),
    port: parsed.PORT,
    ownerEmail: parsed.OWNER_EMAIL.toLowerCase(),
    setupCode: parsed.SETUP_CODE,
    sessionMs: parsed.SESSION_HOURS * 60 * 60 * 1000,
    oidc: parsed.OIDC_ISSUER && parsed.OIDC_CLIENT_ID && parsed.OIDC_CLIENT_SECRET
      ? { issuer: parsed.OIDC_ISSUER.replace(/\/+$/, ""), clientId: parsed.OIDC_CLIENT_ID, clientSecret: parsed.OIDC_CLIENT_SECRET, jit: parsed.OIDC_JIT === "1" }
      : null,
    workspaces: parseWorkspaces(parsed),
  };
}

function parseWorkspaces(parsed: z.infer<typeof envSchema>): WorkspaceConfig | null {
  if (!parsed.WORKSPACE_IMAGE) return null;
  if (!parsed.WORKSPACE_NETWORK || !parsed.MODEL_GATEWAY_URL || !parsed.MODELS) {
    throw new Error("WORKSPACE_IMAGE needs WORKSPACE_NETWORK, MODEL_GATEWAY_URL and MODELS too.");
  }
  return {
    image: parsed.WORKSPACE_IMAGE,
    network: parsed.WORKSPACE_NETWORK,
    modelGatewayUrl: parsed.MODEL_GATEWAY_URL,
    models: workspaceModelsSchema.parse(JSON.parse(parsed.MODELS)),
    memoryMb: parsed.WORKSPACE_MEMORY_MB,
    cpus: parsed.WORKSPACE_CPUS,
    idleMs: parsed.WORKSPACE_IDLE_MINUTES * 60 * 1000,
    dockerUrl: parsed.DOCKER_URL,
  };
}
