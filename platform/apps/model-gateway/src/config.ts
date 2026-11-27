import { z } from "zod";

export const modelSchema = z.object({
  /** The name employees and OpenCode use. */
  alias: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  displayName: z.string().min(1),
  /** OpenAI-compatible base URL inside the network, e.g. http://vllm:8000/v1 */
  upstreamUrl: z.url(),
  upstreamModel: z.string().min(1),
  contextLength: z.number().int().positive(),
  /** Optional key the upstream server itself requires. */
  upstreamApiKey: z.string().min(1).optional(),
});
export type ModelConfig = z.infer<typeof modelSchema>;

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(8791),
  MODELS: z.string().min(2, "MODELS must be a JSON list of models"),
  DAILY_TOKEN_LIMIT: z.coerce.number().int().positive().optional(),
});

export type GatewayConfig = { databaseUrl: string; port: number; models: ModelConfig[]; dailyTokenLimit: number | null };

export function parseGatewayConfig(env: Record<string, string | undefined>): GatewayConfig {
  // Compose passes unset settings as empty strings; treat them as unset.
  const parsed = envSchema.parse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== "")));
  const models = z.array(modelSchema).min(1).parse(JSON.parse(parsed.MODELS));
  const aliases = new Set(models.map((model) => model.alias));
  if (aliases.size !== models.length) throw new Error("MODELS has two entries with the same alias.");
  return { databaseUrl: parsed.DATABASE_URL, port: parsed.PORT, models, dailyTokenLimit: parsed.DAILY_TOKEN_LIMIT ?? null };
}
