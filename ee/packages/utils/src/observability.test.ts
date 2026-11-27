import { describe, expect, test } from "bun:test"

import {
  createJsonStdoutLogger,
  parseObservabilityEnv,
} from "./observability"

describe("observability env contract", () => {
  test("defaults to disabled observability with an explicit service name", () => {
    expect(parseObservabilityEnv({}, { serviceName: "den-api" })).toEqual({
      backend: "none",
      serviceName: "den-api",
    })
  })

  test("parses OTEL HTTP/protobuf defaults with generic and per-signal endpoints", () => {
    const config = parseObservabilityEnv(
      {
        DEN_OBSERVABILITY_BACKEND: "otel",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test/otlp",
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://metrics.example.test/v1/metrics",
      },
      { serviceName: "den-web" },
    )

    expect(config.backend).toBe("otel")
    if (config.backend !== "otel") {
      throw new Error("expected otel backend")
    }

    expect(config.otel.protocol).toBe("http/protobuf")
    expect(config.otel.sampler).toEqual({ name: "parentbased_always_on", ratio: 1 })
    expect(config.otel.signals.traces).toEqual({
      exporter: "otlp",
      protocol: "http/protobuf",
      endpoint: "https://collector.example.test/otlp/v1/traces",
      endpointSource: "base",
    })
    expect(config.otel.signals.metrics).toEqual({
      exporter: "otlp",
      protocol: "http/protobuf",
      endpoint: "https://metrics.example.test/v1/metrics",
      endpointSource: "signal",
    })
    expect(config.otel.signals.logs).toEqual({
      exporter: "otlp",
      protocol: "http/protobuf",
      endpoint: "https://collector.example.test/otlp/v1/logs",
      endpointSource: "base",
    })
  })

  test("allows disabling individual OTEL signal exporters and configuring ratio sampling", () => {
    const config = parseObservabilityEnv(
      {
        DEN_OBSERVABILITY_BACKEND: "otel",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test",
        OTEL_METRICS_EXPORTER: "none",
        OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
        OTEL_TRACES_SAMPLER_ARG: "0.25",
      },
      { serviceName: "den-api" },
    )

    expect(config.backend).toBe("otel")
    if (config.backend !== "otel") {
      throw new Error("expected otel backend")
    }

    expect(config.otel.signals.metrics.exporter).toBe("none")
    expect(config.otel.sampler).toEqual({
      name: "parentbased_traceidratio",
      ratio: 0.25,
      argument: "0.25",
    })
  })

  test("requires explicit endpoints for OTEL signals that export OTLP", () => {
    expect(() => parseObservabilityEnv(
      { DEN_OBSERVABILITY_BACKEND: "otel" },
      { serviceName: "den-api" },
    )).toThrow("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")

    const config = parseObservabilityEnv(
      {
        DEN_OBSERVABILITY_BACKEND: "otel",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example.test/v1/traces",
        OTEL_METRICS_EXPORTER: "none",
        OTEL_LOGS_EXPORTER: "none",
      },
      { serviceName: "den-api" },
    )

    expect(config.backend).toBe("otel")
    if (config.backend !== "otel") {
      throw new Error("expected otel backend")
    }

    expect(config.otel.signals.traces.endpoint).toBe("https://collector.example.test/v1/traces")
    expect(config.otel.signals.metrics).toEqual({
      exporter: "none",
      protocol: "http/protobuf",
      endpoint: undefined,
      endpointSource: "default",
    })
    expect(config.otel.signals.logs).toEqual({
      exporter: "none",
      protocol: "http/protobuf",
      endpoint: undefined,
      endpointSource: "default",
    })
  })

  test("rejects the removed Sentry backend so a deployment cannot report to Sentry", () => {
    expect(() => parseObservabilityEnv(
      { DEN_OBSERVABILITY_BACKEND: "sentry", SENTRY_DSN: "https://public@sentry.example.test/123" },
      { serviceName: "den-api" },
    )).toThrow("must be one of none, otel")
  })

  test("rejects invalid OTEL backend values, exporters, protocols, samplers, and endpoint URLs", () => {
    expect(() => parseObservabilityEnv(
      { DEN_OBSERVABILITY_BACKEND: "debug" },
      { serviceName: "den-api" },
    )).toThrow("DEN_OBSERVABILITY_BACKEND")

    expect(() => parseObservabilityEnv(
      { DEN_OBSERVABILITY_BACKEND: "otel", OTEL_TRACES_EXPORTER: "console" },
      { serviceName: "den-api" },
    )).toThrow("OTEL_TRACES_EXPORTER")

    expect(() => parseObservabilityEnv(
      { DEN_OBSERVABILITY_BACKEND: "otel", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" },
      { serviceName: "den-api" },
    )).toThrow("OTEL_EXPORTER_OTLP_PROTOCOL")

    expect(() => parseObservabilityEnv(
      { DEN_OBSERVABILITY_BACKEND: "otel", OTEL_TRACES_SAMPLER: "custom" },
      { serviceName: "den-api" },
    )).toThrow("OTEL_TRACES_SAMPLER")

    expect(() => parseObservabilityEnv(
      { DEN_OBSERVABILITY_BACKEND: "otel", OTEL_EXPORTER_OTLP_ENDPOINT: "grpc://collector" },
      { serviceName: "den-api" },
    )).toThrow("OTEL_EXPORTER_OTLP_ENDPOINT")
  })

})

describe("json stdout logger", () => {
  test("writes backend-neutral structured JSON lines", () => {
    const lines: string[] = []
    const logger = createJsonStdoutLogger({
      serviceName: "den-api",
      fields: { component: "observability" },
      now: () => new Date("2026-07-11T12:00:00.000Z"),
      write: (line) => lines.push(line),
    })

    logger.info("started", { port: 8790 })

    expect(lines).toEqual([
      JSON.stringify({
        component: "observability",
        port: 8790,
        timestamp: "2026-07-11T12:00:00.000Z",
        level: "info",
        service: "den-api",
        message: "started",
      }),
    ])
  })
})
