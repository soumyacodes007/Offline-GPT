import { z } from "zod";

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
});

export type OidcConfig = { issuer: string; clientId: string; clientSecret: string; jit: boolean };

export type Config = {
  databaseUrl: string;
  publicUrl: URL;
  port: number;
  ownerEmail: string;
  setupCode: string;
  sessionMs: number;
  oidc: OidcConfig | null;
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
  };
}
