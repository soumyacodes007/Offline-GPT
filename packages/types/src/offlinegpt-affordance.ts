import { z } from "zod"

export const OFFLINEGPT_AFFORDANCE_SCHEMA_VERSION = 1

export const offlinegptAffordanceKindSchema = z.enum(["query", "command", "guidance"])
export type OfflineGptAffordanceKind = z.infer<typeof offlinegptAffordanceKindSchema>

export const offlinegptProviderKindSchema = z.enum(["builtin", "extension", "mcp", "connect"])
export type OfflineGptProviderKind = z.infer<typeof offlinegptProviderKindSchema>

export const offlinegptProviderRefSchema = z.object({
  id: z.string().trim().min(1),
  kind: offlinegptProviderKindSchema,
})
export type OfflineGptProviderRef = z.infer<typeof offlinegptProviderRefSchema>

export const offlinegptAffordanceArgumentSchema = z.object({
  name: z.string().trim().min(1),
  type: z.enum(["string", "number", "boolean", "object", "array", "unknown"]),
  required: z.boolean(),
  description: z.string().trim().min(1).optional(),
})
export type OfflineGptAffordanceArgument = z.infer<typeof offlinegptAffordanceArgumentSchema>

export const offlinegptAffordanceEffectsSchema = z.object({
  data: z.enum(["none", "read", "write"]),
  ui: z.enum(["none", "focus", "navigate", "layout", "dialog"]),
  external: z.boolean(),
})
export type OfflineGptAffordanceEffects = z.infer<typeof offlinegptAffordanceEffectsSchema>

export const offlinegptAffordanceAvailabilitySchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(1).optional(),
})
export type OfflineGptAffordanceAvailability = z.infer<typeof offlinegptAffordanceAvailabilitySchema>

export const offlinegptAffordanceExecutorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("offlinegpt") }),
  z.object({
    kind: z.literal("tool"),
    tool: z.string().trim().min(1),
  }),
])
export type OfflineGptAffordanceExecutor = z.infer<typeof offlinegptAffordanceExecutorSchema>

export const offlinegptAffordanceDescriptorSchema = z.object({
  id: z.string().trim().min(1),
  kind: offlinegptAffordanceKindSchema,
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  provider: offlinegptProviderRefSchema,
  arguments: z.array(offlinegptAffordanceArgumentSchema),
  effects: offlinegptAffordanceEffectsSchema,
  confirmation: z.enum(["never", "destructive", "always"]),
  availability: offlinegptAffordanceAvailabilitySchema,
  executor: offlinegptAffordanceExecutorSchema,
})
export type OfflineGptAffordanceDescriptor = z.infer<typeof offlinegptAffordanceDescriptorSchema>

/**
 * Where a request came from: the conversation (session) whose agent issued
 * it. Set by the OfflineGPT bridge, never by the agent, so UI commands such as
 * opening a browser tab can act for the requesting conversation instead of
 * whichever one happens to be on screen.
 */
export const offlinegptAffordanceOriginSchema = z.object({
  sessionId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1).optional(),
})
export type OfflineGptAffordanceOrigin = z.infer<typeof offlinegptAffordanceOriginSchema>

export const offlinegptAffordanceRequestSchema = z.object({
  id: z.string().trim().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  actor: z.string().trim().min(1).optional(),
  origin: offlinegptAffordanceOriginSchema.optional(),
})
export type OfflineGptAffordanceRequest = z.infer<typeof offlinegptAffordanceRequestSchema>

const offlinegptAffordanceSuccessSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  result: z.unknown().optional(),
  revision: z.number().int().nonnegative().optional(),
  effects: offlinegptAffordanceEffectsSchema,
})

const offlinegptAffordanceFailureSchema = z.object({
  ok: z.literal(false),
  id: z.string(),
  error: z.string(),
  code: z.enum(["unavailable", "invalid-args", "conflict", "failed"]),
  revision: z.number().int().nonnegative().optional(),
})

export const offlinegptAffordanceResultSchema = z.discriminatedUnion("ok", [
  offlinegptAffordanceSuccessSchema,
  offlinegptAffordanceFailureSchema,
])
export type OfflineGptAffordanceResult = z.infer<typeof offlinegptAffordanceResultSchema>
