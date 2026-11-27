import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { parseDenApiObservabilityConfig } from "../src/observability/config.js"
import { createRequestAccessLogMiddleware, createTelemetryErrorSanitizerMiddleware } from "../src/observability/hono.js"
import { createAppLogger } from "../src/observability/logger.js"
import { getRuntimeState } from "../src/observability/runtime.js"
import { sanitizeExceptionForTelemetry } from "../src/observability/safe-fields.js"
import {
  AUDIT_ALERT_OPERATIONAL_MARKER,
  SCIM_MAINTENANCE_FAILED_OPERATIONAL_MARKER,
  SCIM_SYNC_FAILURE_RECORDED_OPERATIONAL_MARKER,
} from "../src/operational-log-markers.js"

function parseLogLine(line: string) {
  return JSON.parse(line)
}

describe("den-api observability backend selection", () => {
  test("defaults to no provider and rejects unknown backends", () => {
    expect(parseDenApiObservabilityConfig({}).backend).toBe("none")
    expect(() => parseDenApiObservabilityConfig({ DEN_OBSERVABILITY_BACKEND: "stdout" })).toThrow("DEN_OBSERVABILITY_BACKEND")
  })

  test("selects otel and refuses the removed sentry backend", () => {
    expect(parseDenApiObservabilityConfig({
      DEN_OBSERVABILITY_BACKEND: "otel",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test/otlp",
    }).backend).toBe("otel")
    expect(() => parseDenApiObservabilityConfig({
      DEN_OBSERVABILITY_BACKEND: "sentry",
      SENTRY_DSN: "https://public@sentry.example.test/123",
    })).toThrow("DEN_OBSERVABILITY_BACKEND")
  })

  test("honors OTEL_SERVICE_NAME with a den-api default", () => {
    expect(parseDenApiObservabilityConfig({}).serviceName).toBe("den-api")
    expect(parseDenApiObservabilityConfig({ OTEL_SERVICE_NAME: "custom-den-api" }).serviceName).toBe("custom-den-api")
  })
})

describe("den-api app logger", () => {
  test("writes structured JSON stdout with redaction when no provider is active", () => {
    const lines: string[] = []
    const logger = createAppLogger({
      serviceName: "den-api",
      fields: { component: "test" },
      write: (line) => lines.push(line),
    })

    logger.info("hello", {
      authorization: "Bearer secret",
      url: "https://example.test/path?token=secret",
      nested: { apiKey: "secret" },
    })

    expect(lines).toHaveLength(1)
    expect(parseLogLine(lines[0])).toMatchObject({
      component: "test",
      level: "info",
      service: "den-api",
      message: "hello",
      authorization: "[redacted]",
      url: "https://example.test/path",
      nested: { apiKey: "[redacted]" },
    })
  })

  test("adds active trace correlation when provided by the backend", () => {
    const lines: string[] = []
    const logger = createAppLogger({
      serviceName: "den-api",
      write: (line) => lines.push(line),
      getTraceContext: () => ({ trace_id: "trace-1", span_id: "span-1" }),
    })

    logger.warn("correlated")

    expect(parseLogLine(lines[0])).toMatchObject({
      trace_id: "trace-1",
      span_id: "span-1",
    })
  })

  test("sends the same sanitized correlated event to the provider sink", () => {
    const lines: string[] = []
    const providerEvents: Array<{ level: string; message: string; fields: Record<string, unknown> }> = []
    const logger = createAppLogger({
      serviceName: "den-api",
      write: (line) => lines.push(line),
      getTraceContext: () => ({ trace_id: "trace-2", span_id: "span-2" }),
      emitProviderLog: (level, message, fields) => providerEvents.push({ level, message, fields }),
    })

    logger.error("failed token=secret", { cookie: "secret", url: "https://user:pass@example.test/path?secret=1" })

    expect(parseLogLine(lines[0])).toMatchObject({
      message: "failed token=[redacted]",
      cookie: "[redacted]",
      url: "https://example.test/path",
      trace_id: "trace-2",
      span_id: "span-2",
    })
    expect(providerEvents).toEqual([
      {
        level: "error",
        message: "failed token=[redacted]",
        fields: expect.objectContaining({
          cookie: "[redacted]",
          url: "https://example.test/path",
          trace_id: "trace-2",
          span_id: "span-2",
        }),
      },
    ])
  })

  test("preserves documented operational routing markers in message and fields", () => {
    const lines: string[] = []
    const logger = createAppLogger({
      serviceName: "den-api",
      write: (line) => lines.push(line),
    })

    logger.warn(`${AUDIT_ALERT_OPERATIONAL_MARKER} organization audit alert`, {
      operational_marker: AUDIT_ALERT_OPERATIONAL_MARKER,
    })
    logger.error(`${SCIM_SYNC_FAILURE_RECORDED_OPERATIONAL_MARKER} scim sync failure recorded`, {
      operational_marker: SCIM_SYNC_FAILURE_RECORDED_OPERATIONAL_MARKER,
    })
    logger.error(`${SCIM_MAINTENANCE_FAILED_OPERATIONAL_MARKER} scim maintenance failed`, {
      operational_marker: SCIM_MAINTENANCE_FAILED_OPERATIONAL_MARKER,
    })

    expect(lines.map(parseLogLine)).toMatchObject([
      {
        message: `${AUDIT_ALERT_OPERATIONAL_MARKER} organization audit alert`,
        operational_marker: AUDIT_ALERT_OPERATIONAL_MARKER,
      },
      {
        message: `${SCIM_SYNC_FAILURE_RECORDED_OPERATIONAL_MARKER} scim sync failure recorded`,
        operational_marker: SCIM_SYNC_FAILURE_RECORDED_OPERATIONAL_MARKER,
      },
      {
        message: `${SCIM_MAINTENANCE_FAILED_OPERATIONAL_MARKER} scim maintenance failed`,
        operational_marker: SCIM_MAINTENANCE_FAILED_OPERATIONAL_MARKER,
      },
    ])
  })
})

describe("den-api telemetry sanitization", () => {
  test("sanitizes exception payloads before provider capture", () => {
    const error = new Error("request failed token=secret at https://user:pass@example.test/path?secret=1")
    error.stack = "Error: token=secret\n    at https://user:pass@example.test/path?secret=1"

    const sanitized = sanitizeExceptionForTelemetry(error)

    expect(sanitized.message).toBe("request failed token=[redacted] at https://example.test/path")
    expect(sanitized.stack).not.toContain("secret")
    expect(sanitized.stack).not.toContain("user:pass")
  })

  test("preserves safe database diagnostics without exposing query parameters", () => {
    const cause = Object.assign(
      new Error("Duplicate entry 'oauth-secret-value' for key 'marketplace_plugin_marketplace_plugin'"),
      { code: "ER_DUP_ENTRY", errno: 1062, sqlState: "23000" },
    )
    const error = new Error(
      "Failed query: insert into `marketplace_plugin` values (?, ?)\nparams: oauth-secret-value,plugin-secret",
      { cause },
    )
    error.stack = `${error.message}\n    at store.ts:1:1`

    const sanitized = sanitizeExceptionForTelemetry(error)

    expect(sanitized.message).toContain("params: [redacted]")
    expect(sanitized.message).not.toContain("oauth-secret-value")
    expect(sanitized.stack).not.toContain("oauth-secret-value")
    expect(sanitized.cause).toBeInstanceOf(Error)
    expect(sanitized.cause).toMatchObject({
      message: "Underlying error (ER_DUP_ENTRY, errno 1062, SQLSTATE 23000)",
      code: "ER_DUP_ENTRY",
      errno: 1062,
      sqlState: "23000",
    })
    expect((sanitized.cause as Error).stack).toBeUndefined()
  })

  test("rethrows sanitized request errors before provider middleware observes them", async () => {
    const observedErrors: unknown[] = []
    const app = new Hono()

    app.use("*", async (c, next) => {
      await next()
      observedErrors.push(c.error)
    })
    app.use("*", createTelemetryErrorSanitizerMiddleware())
    app.get("/boom", () => {
      throw new Error("request failed token=secret at https://user:pass@example.test/private/user_123?token=secret")
    })
    app.onError((_error, c) => c.text("caught", 500))

    const response = await app.request("http://den-api.test/boom")
    const observedError = observedErrors[0]

    expect(response.status).toBe(500)
    expect(observedError).toBeInstanceOf(Error)
    if (observedError instanceof Error) {
      expect(observedError.message).toBe("request failed token=[redacted] at https://example.test/private/user_123")
      expect(observedError.stack).not.toContain("secret")
      expect(observedError.stack).not.toContain("user:pass")
    }
  })
})

describe("den-api request access logs", () => {
  test("logs completion fields with normalized routes and skips query values", async () => {
    const lines: string[] = []
    const logger = createAppLogger({ serviceName: "den-api", write: (line) => lines.push(line) })
    const app = new Hono<{ Variables: { requestId: string } }>()

    app.use("*", async (c, next) => {
      c.set("requestId", "request_test")
      await next()
    })
    app.use("*", createRequestAccessLogMiddleware(logger))
    app.get("/v1/orgs/:orgId", (c) => c.json({ ok: true }))

    const response = await app.request("http://den-api.test/v1/orgs/org_123?token=secret")

    expect(response.status).toBe(200)
    expect(lines).toHaveLength(1)
    expect(parseLogLine(lines[0])).toMatchObject({
      request_id: "request_test",
      http_method: "GET",
      http_route: "/v1/orgs/:orgId",
      http_status_code: 200,
    })
    expect(lines[0]).not.toContain("secret")
  })

  test("does not emit noisy health access logs", async () => {
    const lines: string[] = []
    const logger = createAppLogger({ serviceName: "den-api", write: (line) => lines.push(line) })
    const app = new Hono<{ Variables: { requestId: string } }>()

    app.use("*", async (c, next) => {
      c.set("requestId", "request_test")
      await next()
    })
    app.use("*", createRequestAccessLogMiddleware(logger))
    app.get("/health", (c) => c.json({ ok: true }))

    const response = await app.request("http://den-api.test/health")

    expect(response.status).toBe(200)
    expect(lines).toHaveLength(0)
  })

  test("uses a non-raw route label for unmatched requests", async () => {
    const lines: string[] = []
    const logger = createAppLogger({ serviceName: "den-api", write: (line) => lines.push(line) })
    const app = new Hono<{ Variables: { requestId: string } }>()

    app.use("*", async (c, next) => {
      c.set("requestId", "request_test")
      await next()
    })
    app.use("*", createRequestAccessLogMiddleware(logger))

    const response = await app.request("http://den-api.test/private/user_123?token=secret")

    expect(response.status).toBe(404)
    expect(parseLogLine(lines[0])).toMatchObject({
      http_route: "unmatched",
      http_status_code: 404,
    })
    expect(lines[0]).not.toContain("user_123")
    expect(lines[0]).not.toContain("secret")
  })

  test("attaches request context to the active provider hook", async () => {
    const state = getRuntimeState()
    const previousAttachRequestContext = state.attachRequestContext
    const attachedFields: Array<Record<string, unknown>> = []
    const lines: string[] = []
    const logger = createAppLogger({ serviceName: "den-api", write: (line) => lines.push(line) })
    const app = new Hono<{ Variables: { requestId: string } }>()

    state.attachRequestContext = (fields) => {
      attachedFields.push(fields)
    }
    try {
      app.use("*", async (c, next) => {
        c.set("requestId", "request_test")
        await next()
      })
      app.use("*", createRequestAccessLogMiddleware(logger))
      app.get("/v1/orgs/:orgId", (c) => c.json({ ok: true }))

      const response = await app.request("http://den-api.test/v1/orgs/org_123")

      expect(response.status).toBe(200)
      expect(attachedFields).toContainEqual(expect.objectContaining({ request_id: "request_test" }))
      expect(attachedFields).toContainEqual(expect.objectContaining({
        request_id: "request_test",
        http_route: "/v1/orgs/:orgId",
        http_status_code: 200,
      }))
    } finally {
      state.attachRequestContext = previousAttachRequestContext
    }
  })
})
