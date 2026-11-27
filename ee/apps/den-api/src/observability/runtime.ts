import type { Context, Env, Hono, MiddlewareHandler } from "hono"
import type { JsonObject, ObservabilityBackend, ObservabilityConfig, StructuredLogLevel } from "@offlinegpt-ee/utils/observability"
import { observabilityConfig } from "./config.js"
import { normalizedHonoRoute } from "./hono-route.js"
import { sanitizeExceptionForTelemetry, sanitizeFields, stripUrlQuery } from "./safe-fields.js"

type RuntimeState = {
  initialized: boolean
  backend: ObservabilityBackend
  config: ObservabilityConfig
  honoMiddlewares: MiddlewareHandler[]
  emitProviderLog?: (level: StructuredLogLevel, message: string, fields: JsonObject) => void
  getTraceContext?: () => JsonObject | undefined
  captureException?: (error: unknown, fields?: JsonObject) => void
  attachRequestContext?: (fields: JsonObject) => void
  shutdown?: () => Promise<void>
}

declare global {
  var __denApiObservabilityRuntime: RuntimeState | undefined
}

function createInitialRuntimeState(): RuntimeState {
  return {
    initialized: false,
    backend: observabilityConfig.backend,
    config: observabilityConfig,
    honoMiddlewares: [],
  }
}

export function getRuntimeState(): RuntimeState {
  globalThis.__denApiObservabilityRuntime ??= createInitialRuntimeState()
  return globalThis.__denApiObservabilityRuntime
}

function signalConfig(signal: "traces" | "metrics" | "logs") {
  if (observabilityConfig.backend !== "otel") {
    return null
  }
  return observabilityConfig.otel.signals[signal]
}

function exporterOptions(endpoint: string | undefined) {
  return endpoint ? { url: endpoint } : undefined
}

function healthPath(path: string) {
  return path === "/health" || path === "/ready"
}

function stringField(fields: JsonObject, key: string) {
  const value = fields[key]
  return typeof value === "string" ? value : undefined
}

function honoSpanName(c: Context) {
  return `${c.req.method} ${normalizedHonoRoute(c)}`
}

async function startOtel(state: RuntimeState) {
  if (observabilityConfig.backend !== "otel") {
    return
  }

  const [
    api,
    apiLogs,
    sdkNode,
    traceExporterModule,
    metricsExporterModule,
    logsExporterModule,
    sdkMetrics,
    sdkLogs,
    sdkTrace,
    honoOtel,
    semanticConventions,
  ] = await Promise.all([
    import("@opentelemetry/api"),
    import("@opentelemetry/api-logs"),
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-proto"),
    import("@opentelemetry/exporter-metrics-otlp-proto"),
    import("@opentelemetry/exporter-logs-otlp-proto"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/sdk-logs"),
    import("@opentelemetry/sdk-trace-node"),
    import("@hono/otel"),
    import("@opentelemetry/semantic-conventions"),
  ])

  const traces = signalConfig("traces")
  const metrics = signalConfig("metrics")
  const logs = signalConfig("logs")
  const spanProcessors = traces?.exporter === "otlp"
    ? [new sdkTrace.BatchSpanProcessor(new traceExporterModule.OTLPTraceExporter(exporterOptions(traces.endpoint)))]
    : []
  const metricReaders = metrics?.exporter === "otlp"
    ? [new sdkMetrics.PeriodicExportingMetricReader({
        exporter: new metricsExporterModule.OTLPMetricExporter(exporterOptions(metrics.endpoint)),
      })]
    : []
  const logRecordProcessors = logs?.exporter === "otlp"
    ? [new sdkLogs.BatchLogRecordProcessor({
        exporter: new logsExporterModule.OTLPLogExporter(exporterOptions(logs.endpoint)),
      })]
    : []

  const sampler = (() => {
    switch (observabilityConfig.otel.sampler.name) {
      case "always_on":
        return new sdkTrace.AlwaysOnSampler()
      case "always_off":
        return new sdkTrace.AlwaysOffSampler()
      case "traceidratio":
        return new sdkTrace.TraceIdRatioBasedSampler(observabilityConfig.otel.sampler.ratio)
      case "parentbased_always_on":
        return new sdkTrace.ParentBasedSampler({ root: new sdkTrace.AlwaysOnSampler() })
      case "parentbased_always_off":
        return new sdkTrace.ParentBasedSampler({ root: new sdkTrace.AlwaysOffSampler() })
      case "parentbased_traceidratio":
        return new sdkTrace.ParentBasedSampler({
          root: new sdkTrace.TraceIdRatioBasedSampler(observabilityConfig.otel.sampler.ratio),
        })
    }
  })()

  const sdk = new sdkNode.NodeSDK({
    serviceName: observabilityConfig.serviceName,
    sampler,
    instrumentations: [],
    spanProcessors,
    metricReaders,
    logRecordProcessors,
  })
  sdk.start()

  const providerLogger = apiLogs.logs.getLogger(observabilityConfig.serviceName)

  const honoOtelMiddleware = honoOtel.httpInstrumentationMiddleware({
    captureRequestHeaders: [],
    captureResponseHeaders: [],
    serviceName: observabilityConfig.serviceName,
    spanNameFactory: honoSpanName,
  })
  state.honoMiddlewares.push(async (c, next) => {
    if (healthPath(c.req.path)) {
      await next()
      return
    }

    await honoOtelMiddleware(c, next)
  })
  state.honoMiddlewares.push(async (c, next) => {
    try {
      await next()
    } finally {
      const span = api.trace.getActiveSpan()
      if (span) {
        span.setAttribute(semanticConventions.ATTR_URL_FULL, stripUrlQuery(c.req.url))
      }
    }
  })
  state.emitProviderLog = (level, message, fields) => {
    const severityNumber = (() => {
      switch (level) {
        case "debug":
          return apiLogs.SeverityNumber.DEBUG
        case "info":
          return apiLogs.SeverityNumber.INFO
        case "warn":
          return apiLogs.SeverityNumber.WARN
        case "error":
          return apiLogs.SeverityNumber.ERROR
      }
    })()
    providerLogger.emit({
      body: message,
      severityNumber,
      severityText: level,
      attributes: fields,
      context: api.context.active(),
    })
  }
  state.getTraceContext = () => {
    const span = api.trace.getActiveSpan()
    if (!span) {
      return undefined
    }
    const context = span.spanContext()
    return {
      trace_id: context.traceId,
      span_id: context.spanId,
    }
  }
  state.captureException = (error) => {
    const span = api.trace.getActiveSpan()
    if (span) {
      const sanitized = sanitizeExceptionForTelemetry(error)
      span.recordException(sanitized)
      span.setStatus({ code: api.SpanStatusCode.ERROR })
    }
  }
  state.attachRequestContext = (fields) => {
    const span = api.trace.getActiveSpan()
    if (!span) {
      return
    }

    const requestId = stringField(fields, "request_id")
    const route = stringField(fields, "http_route")
    if (requestId) {
      span.setAttribute("request.id", requestId)
    }
    if (route) {
      span.setAttribute(semanticConventions.ATTR_HTTP_ROUTE, route)
    }
  }
  state.shutdown = () => sdk.shutdown()
}

export async function initializeObservability() {
  const state = getRuntimeState()
  if (state.initialized) {
    return state
  }

  state.initialized = true
  try {
    switch (observabilityConfig.backend) {
      case "none":
        return state
      case "otel":
        await startOtel(state)
        return state
    }
  } catch (error) {
    state.initialized = false
    throw error
  }
}

export function captureException(error: unknown, fields?: Readonly<Record<string, unknown>>) {
  const safeFields = sanitizeFields(fields)
  getRuntimeState().captureException?.(error, safeFields)
}

export function attachRequestContext(fields: Readonly<Record<string, unknown>>) {
  const safeFields = sanitizeFields(fields)
  if (safeFields) {
    getRuntimeState().attachRequestContext?.(safeFields)
  }
}

export async function shutdownObservability() {
  const state = getRuntimeState()
  await state.shutdown?.()
}
