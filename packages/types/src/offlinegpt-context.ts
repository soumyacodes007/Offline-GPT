import { z } from "zod"

import {
  offlinegptAffordanceDescriptorSchema,
  offlinegptProviderRefSchema,
} from "./offlinegpt-affordance.js"
import { offlinegptFeatureContributionSchema } from "./offlinegpt-provider.js"

export const OFFLINEGPT_CONTEXT_SCHEMA_VERSION = 1

export const offlinegptSessionRefSchema = z.object({
  workspaceId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  title: z.string().optional(),
})
export type OfflineGptSessionRef = z.infer<typeof offlinegptSessionRefSchema>

export const offlinegptScreenSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("conversation"),
    route: z.string(),
    workspaceId: z.string().optional(),
    sessionId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("settings"),
    route: z.string(),
    workspaceId: z.string().optional(),
    panel: z.string(),
  }),
  z.object({
    kind: z.literal("other"),
    route: z.string(),
  }),
])
export type OfflineGptScreen = z.infer<typeof offlinegptScreenSchema>

export const offlinegptConversationLayoutSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty") }),
  z.object({
    kind: z.literal("single"),
    sessionId: z.string(),
    workspaceId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("split"),
    primarySessionId: z.string(),
    primaryWorkspaceId: z.string().optional(),
    secondarySessionId: z.string(),
    secondaryWorkspaceId: z.string().optional(),
    focused: z.enum(["primary", "secondary"]),
  }),
])
export type OfflineGptConversationLayout = z.infer<typeof offlinegptConversationLayoutSchema>

export const offlinegptPanelTabSchema = z.object({
  id: z.string(),
  kind: z.enum(["browser", "artifact"]),
  label: z.string(),
  url: z.string().optional(),
  status: z.enum(["loading", "ready", "suspending", "suspended", "restoring"]).optional(),
})
export type OfflineGptPanelTab = z.infer<typeof offlinegptPanelTabSchema>

export const offlinegptResourceDescriptorSchema = z.object({
  ref: z.string().trim().min(1),
  kind: z.enum(["workspace", "session", "screen", "side-panel", "settings"]),
  title: z.string(),
  provider: offlinegptProviderRefSchema,
  state: z.record(z.string(), z.unknown()),
})
export type OfflineGptResourceDescriptor = z.infer<typeof offlinegptResourceDescriptorSchema>

export const offlinegptContextSnapshotSchema = z.object({
  schemaVersion: z.literal(OFFLINEGPT_CONTEXT_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  capturedAt: z.string(),
  screen: offlinegptScreenSchema,
  conversations: z.object({
    tabs: z.array(offlinegptSessionRefSchema),
    layout: offlinegptConversationLayoutSchema,
    pinnedSessionIds: z.array(z.string()),
  }),
  chrome: z.object({
    sidebarOpen: z.boolean(),
    applicationMenuVisible: z.boolean(),
    rightSidebarExpanded: z.boolean(),
  }),
  execution: z.object({
    queries: z.literal("parallel"),
    commands: z.literal("serialized"),
    busyCommandId: z.string().nullable(),
    busyActor: z.string().nullable(),
  }),
  sidePanel: z.object({
    open: z.boolean(),
    ownerSessionId: z.string().nullable(),
    kind: z.enum(["panel", "extensions"]).nullable(),
    tabs: z.array(offlinegptPanelTabSchema),
    activeTabId: z.string().nullable(),
  }),
  resources: z.array(offlinegptResourceDescriptorSchema),
  availableAffordances: z.array(offlinegptAffordanceDescriptorSchema),
  contributions: z.array(offlinegptFeatureContributionSchema),
})
export type OfflineGptContextSnapshot = z.infer<typeof offlinegptContextSnapshotSchema>
