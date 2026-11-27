import type { ChatCompletionReport } from "./chat-response.js"

export type PayloadLogMode = "summary"

export type InferenceRequestReport = {
  organizationId: string
  orgMembershipId: string
  inferenceKeyId: string
  offlinegptRequestId: string
  route: string
  method: string
  incomingModel: string | null
  resolvedUpstreamModel: string | null
  headers: Record<string, string>
  payloadMode: PayloadLogMode
  payload: unknown
}

export type InferenceHandledErrorReport = {
  reason: string
  organizationId?: string
  orgMembershipId?: string
  inferenceKeyId?: string
  offlinegptRequestId?: string
  route: string
  method: string
  incomingModel?: string | null
  resolvedUpstreamModel?: string | null
  headers?: Record<string, string>
  status?: number
  statusText?: string
  upstreamUrl?: string
  error?: string
  exception?: unknown
}

export type InferenceReporter = {
  request(report: InferenceRequestReport): void
  handledError(report: InferenceHandledErrorReport): void
  completion?(report: ChatCompletionReport & { offlinegptRequestId: string; organizationId: string; orgMembershipId: string; modelAlias: string }): void
}

type PayloadLog = {
  mode: PayloadLogMode
  payload: unknown
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function sanitizeIncomingHeaders(headers: Headers) {
  const sanitized: Record<string, string> = {}
  for (const header of ["content-type", "accept", "content-length"]) {
    const value = headers.get(header)
    if (value) sanitized[header] = value
  }
  return sanitized
}

function summarizePayload(value: unknown) {
  if (!isJsonObject(value)) return { bodyType: "invalid" }
  const messages = Array.isArray(value.messages) ? value.messages : []
  const tools = Array.isArray(value.tools) ? value.tools : []
  return {
    bodyType: "object",
    stream: typeof value.stream === "boolean" ? value.stream : null,
    messageCount: messages.length,
    toolCount: tools.length,
    roles: messages.map((message) => isJsonObject(message) && ["system", "developer", "user", "assistant", "tool"].includes(String(message.role)) ? message.role : "unknown"),
  }
}

export function buildInferencePayloadLog(_organizationId: string, payload: unknown): PayloadLog {
  return { mode: "summary", payload: summarizePayload(payload) }
}

export function buildUnparsedPayloadLog(reason: string, contentType: string | null): PayloadLog {
  return {
    mode: "summary",
    payload: {
      bodyType: "unparsed",
      reason,
      contentType,
    },
  }
}

function reportAttributes(report: InferenceRequestReport | InferenceHandledErrorReport) {
  return {
    organizationId: report.organizationId,
    orgMembershipId: report.orgMembershipId,
    inferenceKeyId: report.inferenceKeyId,
    offlinegptRequestId: report.offlinegptRequestId,
    route: report.route,
    method: report.method,
    incomingModel: report.incomingModel,
    resolvedUpstreamModel: report.resolvedUpstreamModel,
    headers: report.headers,
  }
}

function writeLog(level: "info" | "error", message: string, fields: Record<string, unknown>) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, service: "inference", message, ...fields })
  if (level === "error") console.error(line)
  else console.log(line)
}

// Reports go to this process's stdout only. The gateway sends nothing to an
// external monitoring service, and request payloads are never logged.
export const stdoutInferenceReporter: InferenceReporter = {
  completion(report) {
    if (report.outcome !== "completed") writeLog("error", "OfflineGPT inference completion", report)
  },
  request() {},
  handledError(report) {
    writeLog("error", "OfflineGPT inference handled error", {
      ...reportAttributes(report),
      reason: report.reason,
      status: report.status,
      statusText: report.statusText,
      upstreamUrl: report.upstreamUrl,
      error: report.error ?? (report.exception instanceof Error ? report.exception.message : undefined),
    })
  },
}
