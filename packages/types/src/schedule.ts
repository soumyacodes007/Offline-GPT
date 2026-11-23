import { z } from "zod"

/**
 * Scheduled tasks, modeled on DeepSeek Harness's Schedule subsystem: one
 * evaluator for seven authoritative timing kinds, and delivery as an ordinary
 * message into a target chat. Snake-case timing fields match the model-facing
 * tool schema so agents and the UI send the same shape.
 */

const timeZone = z.string().trim().min(1).max(64)
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Use HH:mm or HH:mm:ss")

export const scheduleTimingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("after"), after_seconds: z.number().int().positive().max(366 * 24 * 3600) }),
  z.object({
    kind: z.literal("at"),
    at: z.union([
      z.string().min(1),
      z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: localTime, time_zone: timeZone }),
    ]),
  }),
  z.object({ kind: z.literal("every"), every_seconds: z.number().int().min(60).max(366 * 24 * 3600) }),
  z.object({ kind: z.literal("daily"), daily: z.object({ time: localTime, time_zone: timeZone }) }),
  z.object({
    kind: z.literal("weekly"),
    weekly: z.object({
      time: localTime,
      time_zone: timeZone,
      /** ISO weekdays, Monday 1 through Sunday 7. */
      weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    }),
  }),
  z.object({ kind: z.literal("cron"), cron: z.object({ expression: z.string().trim().min(1).max(120), time_zone: timeZone }) }),
  z.object({ kind: z.literal("rrule"), rrule: z.string().trim().min(1).max(1000) }),
])
export type ScheduleTiming = z.infer<typeof scheduleTimingSchema>

export const scheduleTargetSchema = z.discriminatedUnion("kind", [
  /** Create one chat on first delivery and reuse it afterwards. */
  z.object({ kind: z.literal("new_once") }),
  /** Create a fresh chat for every delivery. */
  z.object({ kind: z.literal("new") }),
  /** Deliver into an existing chat. */
  z.object({ kind: z.literal("session"), session_id: z.string().trim().min(1) }),
])
export type ScheduleTarget = z.infer<typeof scheduleTargetSchema>

export const scheduleModelSchema = z.object({ provider_id: z.string().trim().min(1), model_id: z.string().trim().min(1) })
export type ScheduleModel = z.infer<typeof scheduleModelSchema>

export const scheduleCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(16_000),
  timing: scheduleTimingSchema,
  target: scheduleTargetSchema.default({ kind: "new_once" }),
  model: scheduleModelSchema.nullable().optional(),
})
export type ScheduleCreateRequest = z.input<typeof scheduleCreateSchema>

export const scheduleUpdateSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  prompt: z.string().trim().min(1).max(16_000).optional(),
  timing: scheduleTimingSchema.optional(),
  target: scheduleTargetSchema.optional(),
  model: scheduleModelSchema.nullable().optional(),
  /** Pause or resume. Resuming a delivered one-shot needs new timing. */
  active: z.boolean().optional(),
  /** Optimistic concurrency: the `updatedAt` the caller last read. */
  expected_updated_at: z.string().optional(),
}).strict()
export type ScheduleUpdateRequest = z.input<typeof scheduleUpdateSchema>

export type ScheduleTaskState = "active" | "paused" | "ended"

export type ScheduleDelivery = {
  scheduledAt: string
  deliveredAt: string
  /** The chat the message was written to. */
  sessionId: string | null
  /** Manual "run now" deliveries do not move the schedule. */
  manual: boolean
  ok: boolean
  error?: string
}

export type ScheduleTask = {
  id: string
  workspaceId: string
  title: string
  prompt: string
  timing: ScheduleTiming
  target: ScheduleTarget
  model: ScheduleModel | null
  state: ScheduleTaskState
  /** Next committed occurrence (RFC 3339 UTC), null once ended or paused. */
  nextRunAt: string | null
  /** Chat reserved by a `new_once` target, created on first delivery. */
  reservedSessionId: string | null
  createdAt: string
  updatedAt: string
  lastDelivery: ScheduleDelivery | null
  /** Newest first, at most 200 records and 30 days. */
  history: ScheduleDelivery[]
}

export type ScheduleListResult = { items: ScheduleTask[]; total: number }
