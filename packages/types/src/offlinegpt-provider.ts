import { z } from "zod"

import {
  offlinegptAffordanceDescriptorSchema,
  offlinegptProviderRefSchema,
} from "./offlinegpt-affordance.js"

export const offlinegptGuidanceDescriptorSchema = z.object({
  ref: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  provider: offlinegptProviderRefSchema,
  loading: z.enum(["eager", "catalog", "on-demand"]),
})
export type OfflineGptGuidanceDescriptor = z.infer<typeof offlinegptGuidanceDescriptorSchema>

export const offlinegptFeatureContributionSchema = z.object({
  featureId: z.string().trim().min(1),
  provider: offlinegptProviderRefSchema,
  affordances: z.array(offlinegptAffordanceDescriptorSchema),
  guidance: z.array(offlinegptGuidanceDescriptorSchema),
})
export type OfflineGptFeatureContribution = z.infer<typeof offlinegptFeatureContributionSchema>

export const offlinegptProviderCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  contributions: z.array(offlinegptFeatureContributionSchema),
})
export type OfflineGptProviderCatalog = z.infer<typeof offlinegptProviderCatalogSchema>

export const offlinegptCapabilityResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    data: z.unknown(),
    additionalContext: z.array(z.string()).optional(),
  }),
  z.object({
    status: z.literal("guidance"),
    instructions: z.array(z.string()),
  }),
  z.object({
    status: z.literal("requires-user-action"),
    message: z.string(),
    action: z.string().optional(),
  }),
  z.object({
    status: z.literal("failed"),
    error: z.string(),
    retryable: z.boolean(),
  }),
])
export type OfflineGptCapabilityResult = z.infer<typeof offlinegptCapabilityResultSchema>
