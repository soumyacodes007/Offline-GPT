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
  SAML_ENTRY_POINT: z.url().optional(),
  SAML_IDP_CERT: optional,
  SAML_ENTITY_ID: optional,
  SAML_JIT: z.enum(["0", "1"]).default("0"),
  WORKSPACE_IMAGE: optional,
  WORKSPACE_NETWORK: optional,
  MODEL_GATEWAY_URL: z.url().optional(),
  CONTROL_INTERNAL_URL: z.url().optional(),
  MODELS: optional,
  DOCKER_URL: z.string().default("unix:///var/run/docker.sock"),
  WORKSPACE_MEMORY_MB: z.coerce.number().int().min(512).default(4096),
  WORKSPACE_CPUS: z.coerce.number().positive().max(64).default(2),
  WORKSPACE_IDLE_MINUTES: z.coerce.number().int().min(5).default(60),
  /** Days a leaver's workspace files are kept after deactivation; 0 keeps them forever. */
  WORKSPACE_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(90),
  CONSOLE_DIR: optional,
  /** Where employees open their workspace app; same host as PUBLIC_URL, its own port. */
  WORKSPACE_PUBLIC_URL: z.url().optional(),
  WORKSPACE_ORIGIN_PORT: z.coerce.number().int().min(1).max(65535).default(8793),
  /** Encrypts stored secrets such as connection credentials. At least 32 characters. */
  /** Forward every audit event to syslog: udp://host:514 or tcp://host:514. */
  AUDIT_SYSLOG: z.string().regex(/^(udp|tcp):\/\/[^/]+$/, "AUDIT_SYSLOG must look like udp://host:514 or tcp://host:514").optional(),
  SECRETS_KEY: z.string().min(32, "SECRETS_KEY must be at least 32 characters").optional(),
});

const workspaceModelsSchema = z.array(z.object({ alias: z.string().min(1), displayName: z.string().min(1), contextLength: z.number().int().positive() })).min(1);

export type OidcConfig = { issuer: string; clientId: string; clientSecret: string; jit: boolean };
export type SamlConfig = { entryPoint: string; idpCert: string; entityId: string; jit: boolean };

export type WorkspaceConfig = WorkspaceSettings & { dockerUrl: string; retentionMs: number | null };

export type Config = {
  databaseUrl: string;
  publicUrl: URL;
  port: number;
  ownerEmail: string;
  setupCode: string;
  sessionMs: number;
  oidc: OidcConfig | null;
  saml: SamlConfig | null;
  /** Null when this deployment does not run per-member workspaces. */
  workspaces: WorkspaceConfig | null;
  /** Built console files to serve at `/`; null serves the API only. */
  consoleDir: string | null;
  /** Public URL of the workspace origin, or null when workspaces are off. */
  workspaceUrl: URL | null;
  workspaceOriginPort: number;
  /** Null when no SECRETS_KEY is set: secrets can't be stored. */
  secretsKey: string | null;
  auditSyslog: string | null;
};

/** Compose and many service managers pass unset settings as empty strings; treat them as unset. */
export function withoutEmpty(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).flatMap(([key, value]) => (value === undefined || value.trim() === "" ? [] : [[key, value]])));
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = envSchema.parse(withoutEmpty(env));
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
    saml: parseSaml(parsed),
    workspaces: parseWorkspaces(parsed),
    consoleDir: parsed.CONSOLE_DIR ?? null,
    workspaceUrl: parsed.WORKSPACE_IMAGE && parsed.WORKSPACE_PUBLIC_URL ? new URL(parsed.WORKSPACE_PUBLIC_URL) : null,
    workspaceOriginPort: parsed.WORKSPACE_ORIGIN_PORT,
    secretsKey: parsed.SECRETS_KEY ?? null,
    auditSyslog: parsed.AUDIT_SYSLOG ?? null,
  };
}

function parseSaml(parsed: z.infer<typeof envSchema>): SamlConfig | null {
  if (Boolean(parsed.SAML_ENTRY_POINT) !== Boolean(parsed.SAML_IDP_CERT)) throw new Error("Set both SAML_ENTRY_POINT and SAML_IDP_CERT, or neither.");
  if (!parsed.SAML_ENTRY_POINT || !parsed.SAML_IDP_CERT) return null;
  // Accept a PEM certificate or its bare base64 body.
  const idpCert = parsed.SAML_IDP_CERT.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  return {
    entryPoint: parsed.SAML_ENTRY_POINT,
    idpCert,
    entityId: parsed.SAML_ENTITY_ID ?? new URL("/auth/saml/metadata", parsed.PUBLIC_URL).toString(),
    jit: parsed.SAML_JIT === "1",
  };
}

function parseWorkspaces(parsed: z.infer<typeof envSchema>): WorkspaceConfig | null {
  if (!parsed.WORKSPACE_IMAGE) return null;
  if (!parsed.WORKSPACE_NETWORK || !parsed.MODEL_GATEWAY_URL || !parsed.CONTROL_INTERNAL_URL || !parsed.MODELS) {
    throw new Error("WORKSPACE_IMAGE needs WORKSPACE_NETWORK, MODEL_GATEWAY_URL, CONTROL_INTERNAL_URL and MODELS too.");
  }
  return {
    image: parsed.WORKSPACE_IMAGE,
    network: parsed.WORKSPACE_NETWORK,
    modelGatewayUrl: parsed.MODEL_GATEWAY_URL,
    controlUrl: parsed.CONTROL_INTERNAL_URL,
    models: workspaceModelsSchema.parse(JSON.parse(parsed.MODELS)),
    memoryMb: parsed.WORKSPACE_MEMORY_MB,
    cpus: parsed.WORKSPACE_CPUS,
    idleMs: parsed.WORKSPACE_IDLE_MINUTES * 60 * 1000,
    dockerUrl: parsed.DOCKER_URL,
    retentionMs: parsed.WORKSPACE_RETENTION_DAYS === 0 ? null : parsed.WORKSPACE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  };
}
