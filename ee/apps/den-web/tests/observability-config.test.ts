import { describe, expect, test } from "bun:test";
import { SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import type { SpanContext } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";

import { scrubOtelSpan } from "../observability/otel-node";
import { scrubText } from "../observability/scrub";
import { getDenWebObservabilityConfig, resolveInstrumentationActionForBackend } from "../observability/server-config";
import {
  isTelemetrySdkStarted,
  registerRetainedTelemetryShutdownHandlers,
  resetDenWebObservabilityStateForTests,
  retainTelemetrySdk,
  shutdownRetainedTelemetry,
} from "../observability/runtime-logger";
import type { TelemetryShutdownSignal } from "../observability/runtime-logger";

function readAppFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

type SignalListener = () => void;

class FakeSignalTarget {
  readonly listeners: { SIGTERM: SignalListener[]; SIGINT: SignalListener[] } = { SIGTERM: [], SIGINT: [] };

  on(signal: TelemetryShutdownSignal, listener: SignalListener): void {
    this.listeners[signal].push(listener);
  }

  emit(signal: TelemetryShutdownSignal): void {
    for (const listener of this.listeners[signal]) {
      listener();
    }
  }
}

function serverPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }
  return address.port;
}

function makeFinishedReadableSpan(): ReadableSpan {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "den-web-test" }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const linkContext: SpanContext = {
    traceId: "11111111111111111111111111111111",
    spanId: "2222222222222222",
    traceFlags: TraceFlags.SAMPLED,
  };

  const tracer = provider.getTracer("den-web-test", "1.0.0", { schemaUrl: "https://schema.example.test" });
  const span = tracer.startSpan("GET /api/den/v1/me?token=secret", {
    attributes: {
      authorization: "Bearer secret",
      "http.url": "https://api.example.test/v1/me?token=secret",
    },
    links: [{
      context: linkContext,
      attributes: { authorization: "Bearer secret" },
    }],
  });
  span.addEvent("fetch /api/den/v1/me?token=secret", { cookie: "sid=secret" });
  span.setStatus({ code: SpanStatusCode.ERROR, message: "failed token=secret" });
  span.end();

  const finished = exporter.getFinishedSpans()[0];
  if (finished === undefined) {
    throw new Error("Expected a finished span");
  }
  return finished;
}

async function exportSpanToLocalOtlp(span: ReadableSpan): Promise<Buffer[]> {
  const requests: Buffer[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      requests.push(Buffer.concat(chunks));
      response.writeHead(200, { "content-type": "application/x-protobuf" });
      response.end();
    });
  });

  await listen(server);
  const exporter = new OTLPTraceExporter({ url: `http://127.0.0.1:${serverPort(server)}/v1/traces` });
  try {
    await new Promise<void>((resolve, reject) => {
      exporter.export([span], (result) => {
        if (result.error !== undefined) {
          reject(result.error);
          return;
        }
        if (result.code !== 0) {
          reject(new Error("OTLP trace export failed"));
          return;
        }
        resolve();
      });
    });
  } finally {
    await exporter.shutdown();
    await close(server);
  }

  return requests;
}

describe("den-web observability backend dispatch", () => {
  test("selects exactly one runtime initializer", () => {
    expect(resolveInstrumentationActionForBackend("otel", "nodejs")).toBe("otel-node");
    expect(resolveInstrumentationActionForBackend("otel", "edge")).toBe("none");
    expect(resolveInstrumentationActionForBackend("none", "nodejs")).toBe("none");
  });

  test("honors OTEL_SERVICE_NAME with a den-web default", () => {
    expect(getDenWebObservabilityConfig({}).serviceName).toBe("den-web");
    expect(getDenWebObservabilityConfig({ OTEL_SERVICE_NAME: " den-web-custom " }).serviceName).toBe("den-web-custom");
  });

  test("keeps NodeSDK imports out of the Edge instrumentation graph", () => {
    const instrumentation = readAppFile("instrumentation.ts");

    expect(instrumentation).toContain('if (process.env.NEXT_RUNTIME === "nodejs")');
    expect(instrumentation).toContain('await import("./observability/otel-node")');
    expect(instrumentation).not.toContain('from "./observability/otel-node"');
  });

  test("retains telemetry runtime state on globalThis and uses the 0.220 log processor constructor", () => {
    expect(readAppFile("observability/runtime-logger.ts")).toContain("globalThis.__denWebObservabilityState");
    const otelNode = readAppFile("observability/otel-node.ts");
    expect(otelNode).toContain("new BatchLogRecordProcessor({");
    expect(otelNode).toContain("exporter: new OTLPLogExporter");
  });

  test("registers bounded OTEL shutdown signal handlers once globally", async () => {
    resetDenWebObservabilityStateForTests();
    const target = new FakeSignalTarget();
    let flushes = 0;
    let shutdowns = 0;
    retainTelemetrySdk({
      forceFlush: async () => {
        flushes += 1;
      },
      shutdown: async () => {
        shutdowns += 1;
      },
    });

    expect(registerRetainedTelemetryShutdownHandlers(target, 25)).toBe(true);
    expect(registerRetainedTelemetryShutdownHandlers(target, 25)).toBe(false);
    expect(target.listeners.SIGTERM).toHaveLength(1);
    expect(target.listeners.SIGINT).toHaveLength(1);

    target.emit("SIGTERM");
    await shutdownRetainedTelemetry(25);

    expect(flushes).toBe(1);
    expect(shutdowns).toBe(1);
    expect(isTelemetrySdkStarted()).toBe(false);

    target.emit("SIGINT");
    await shutdownRetainedTelemetry(25);
    expect(flushes).toBe(1);
    expect(shutdowns).toBe(1);
  });

  test("bounds stuck OTEL flushes and still attempts shutdown", async () => {
    resetDenWebObservabilityStateForTests();
    let shutdowns = 0;
    retainTelemetrySdk({
      forceFlush: () => new Promise(() => {}),
      shutdown: async () => {
        shutdowns += 1;
      },
    });

    await shutdownRetainedTelemetry(5);
    expect(shutdowns).toBe(1);
    expect(isTelemetrySdkStarted()).toBe(false);
  });
});

describe("den-web observability scrubbing", () => {
  test("removes query strings and obvious secrets from telemetry text", () => {
    expect(scrubText("GET https://api.example.test/v1/me?token=secret&email=a@example.test Authorization: Bearer abc123")).toBe(
      "GET https://api.example.test/v1/me?[redacted-query] Authorization: [redacted]",
    );
    expect(scrubText('body: {"token":"secret","password":"pw"} cookie: sid=secret')).toBe(
      "body: [redacted]",
    );
  });

  test("scrubs OTEL spans without dropping methods required by OTLP serialization", async () => {
    const span = makeFinishedReadableSpan();
    const sanitized = scrubOtelSpan(span);

    expect(Object.getPrototypeOf(sanitized)).toBe(Object.getPrototypeOf(span));
    expect(sanitized.spanContext()).toEqual(span.spanContext());
    expect(sanitized.resource).toBe(span.resource);
    expect(sanitized.instrumentationScope).toBe(span.instrumentationScope);
    expect(sanitized.name).toBe("GET /api/den/v1/me?[redacted-query]");
    expect(sanitized.status.message).toBe("failed token=[redacted]");
    expect(sanitized.attributes.authorization).toBe("[redacted]");
    expect(sanitized.attributes["http.url"]).toBe("https://api.example.test/v1/me?[redacted-query]");

    const event = sanitized.events[0];
    if (event === undefined) {
      throw new Error("Expected a sanitized event");
    }
    expect(event.name).toBe("fetch /api/den/v1/me?[redacted-query]");
    expect(event.attributes?.cookie).toBe("[redacted]");

    const link = sanitized.links[0];
    if (link === undefined) {
      throw new Error("Expected a sanitized link");
    }
    expect(link.attributes?.authorization).toBe("[redacted]");

    expect(span.name).toBe("GET /api/den/v1/me?token=secret");
    expect(span.status.message).toBe("failed token=secret");
    expect(span.attributes.authorization).toBe("Bearer secret");

    const requests = await exportSpanToLocalOtlp(sanitized);
    const request = requests[0];
    if (request === undefined) {
      throw new Error("Expected a local OTLP request");
    }
    expect(request.byteLength).toBeGreaterThan(0);
  });
});
