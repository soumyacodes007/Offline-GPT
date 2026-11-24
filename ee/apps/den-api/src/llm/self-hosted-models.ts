import { z } from "zod"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"

const logger = appLogger.child({ component: "self_hosted_models" })

/**
 * The air-gapped edition's models are whatever the inference gateway serves.
 * Workspaces need them listed on the provider itself (OpenCode v2 does not
 * fill a custom provider's models from the catalog), so Den reads the
 * gateway's OpenCode catalog over the internal network when it delivers the
 * "OfflineGPT Models" provider. Cached briefly; on failure it returns the last
 * list it saw, or none.
 */
const CatalogSchema = z.object({
  offlinegpt: z.object({
    models: z.record(z.string(), z.record(z.string(), z.unknown())),
  }),
})

export type SelfHostedModel = { modelId: string; name: string; modelConfig: Record<string, unknown> }

const TTL_MS = 30_000
let cached: { at: number; models: SelfHostedModel[] } | null = null

export async function listSelfHostedModels(fetchImpl: typeof fetch = fetch): Promise<SelfHostedModel[]> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.models
  try {
    const response = await fetchImpl(`${env.inferenceProxyBaseUrl.replace(/\/+$/, "")}/models/api.json`, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error(`catalog returned ${response.status}`)
    const catalog = CatalogSchema.parse(await response.json())
    const models = Object.entries(catalog.offlinegpt.models).map(([modelId, modelConfig]) => ({
      modelId,
      name: typeof modelConfig.name === "string" ? modelConfig.name : modelId,
      modelConfig,
    }))
    cached = { at: Date.now(), models }
    return models
  } catch (error) {
    logger.warn("self-hosted model catalog unavailable", { message: error instanceof Error ? error.message : String(error) })
    return cached?.models ?? []
  }
}
