import { INFERENCE_MODEL_ALIASES } from "@offlinegpt/types/den/inference"
import { z } from "zod"

const OFFLINEGPT_PROVIDER_ID = "offlinegpt"

export type ModelCatalogEntry = {
  alias: string
  upstreamModel: string
  displayName: string
  enabled: boolean
  usageFactor: number
  /** Self-hosted only: the context window the server reports (vLLM max_model_len). */
  contextLength?: number
}

const models: ModelCatalogEntry[] = Object.entries(INFERENCE_MODEL_ALIASES).map(([alias, model]) => ({
  alias,
  upstreamModel: model.upstreamModel,
  displayName: model.displayName,
  enabled: model.enabled,
  usageFactor: model.usageFactor,
}))

const enabledModels = models.filter((model) => model.enabled)

function normalizeAlias(alias: string) {
  return alias.startsWith(`${OFFLINEGPT_PROVIDER_ID}/`) ? alias.slice(OFFLINEGPT_PROVIDER_ID.length + 1) : alias
}

export function findModelAlias(catalog: readonly ModelCatalogEntry[], alias: string) {
  const normalizedAlias = normalizeAlias(alias)
  return catalog.find((model) => model.alias === normalizedAlias) ?? null
}

export function resolveModelAlias(alias: string) {
  return findModelAlias(enabledModels, alias)
}

export function resolveModelByUpstreamModel(upstreamModel: string) {
  return enabledModels.find((model) => model.upstreamModel === upstreamModel) ?? null
}

export function listModelCatalog() {
  return enabledModels
}

// Self-hosted catalog: either listed explicitly in INFERENCE_MODELS, or read
// from the upstream's OpenAI-compatible GET /models (vLLM serves its
// --served-model-name there).
const ConfiguredModelsSchema = z.array(z.object({
  alias: z.string().trim().min(1),
  upstreamModel: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1).optional(),
  contextLength: z.number().int().positive().optional(),
}))

export function parseConfiguredModels(value: string): ModelCatalogEntry[] {
  let json: unknown
  try {
    json = JSON.parse(value)
  } catch {
    throw new Error("INFERENCE_MODELS must be a JSON array of { alias, upstreamModel?, displayName? }")
  }
  return ConfiguredModelsSchema.parse(json).map((model) => ({
    alias: model.alias,
    upstreamModel: model.upstreamModel ?? model.alias,
    displayName: model.displayName ?? model.alias,
    enabled: true,
    usageFactor: 1,
    ...(model.contextLength ? { contextLength: model.contextLength } : {}),
  }))
}

const UpstreamModelsSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1), max_model_len: z.number().int().positive().optional() })),
})

export function createSelfHostedCatalog(input: {
  upstreamUrl: string
  apiKey?: string
  configured?: ModelCatalogEntry[]
  fetchImpl?: typeof fetch
  ttlMs?: number
  now?: () => number
}) {
  const fetchImpl = input.fetchImpl ?? fetch
  const ttlMs = input.ttlMs ?? 30_000
  const now = input.now ?? Date.now
  let cached: { at: number; entries: ModelCatalogEntry[] } | null = null

  return async function selfHostedCatalog(): Promise<ModelCatalogEntry[]> {
    if (input.configured) return input.configured
    if (cached && now() - cached.at < ttlMs) return cached.entries
    const headers = new Headers({ accept: "application/json" })
    if (input.apiKey) headers.set("authorization", `Bearer ${input.apiKey}`)
    const response = await fetchImpl(`${input.upstreamUrl}/models`, { headers, redirect: "error", signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error(`Self-hosted upstream /models returned ${response.status}`)
    const entries = UpstreamModelsSchema.parse(await response.json()).data.map((model) => ({
      alias: model.id,
      upstreamModel: model.id,
      displayName: model.id,
      enabled: true,
      usageFactor: 1,
      ...(model.max_model_len ? { contextLength: model.max_model_len } : {}),
    }))
    cached = { at: now(), entries }
    return entries
  }
}

/**
 * The models.dev-style catalog OpenCode reads from `$OPENCODE_MODELS_URL/api.json`,
 * listing only the self-hosted models behind this gateway. Workspaces in the
 * air-gapped edition point OPENCODE_MODELS_URL here instead of the public catalog.
 */
export function buildOpencodeModelsCatalog(catalog: readonly ModelCatalogEntry[], proxyBaseUrl: string) {
  const models: Record<string, unknown> = {}
  for (const model of catalog) {
    const context = model.contextLength ?? 32768
    models[model.alias] = {
      id: model.alias,
      name: model.displayName,
      attachment: false,
      reasoning: false,
      tool_call: true,
      temperature: true,
      open_weights: true,
      modalities: { input: ["text"], output: ["text"] },
      limit: { context, output: Math.min(8192, Math.max(1024, Math.floor(context / 4))) },
      cost: { input: 0, output: 0 },
    }
  }
  return {
    [OFFLINEGPT_PROVIDER_ID]: {
      id: OFFLINEGPT_PROVIDER_ID,
      env: ["OFFLINEGPT_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      name: "OfflineGPT Models",
      api: `${proxyBaseUrl.replace(/\/+$/, "")}/api/v1`,
      models,
    },
  }
}
