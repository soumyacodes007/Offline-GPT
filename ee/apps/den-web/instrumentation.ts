export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getDenWebObservabilityConfig } = await import("./observability/server-config");
    const config = getDenWebObservabilityConfig(process.env);

    if (config.backend === "otel") {
      const { startOtel } = await import("./observability/otel-node");
      startOtel(config);
      return;
    }

    const { useJsonStdoutStructuredLogSink } = await import("./observability/runtime-logger");
    useJsonStdoutStructuredLogSink();
    return;
  }

  const { useJsonStdoutStructuredLogSink } = await import("./observability/runtime-logger");
  useJsonStdoutStructuredLogSink();
}
