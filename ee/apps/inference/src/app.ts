import "./load-env.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "@offlinegpt-ee/den-db/drizzle";
import { cors } from "hono/cors";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "./db.js";
import { env } from "./env.js";
import { buildOpencodeModelsCatalog } from "./model-catalog.js";
import { defaultModelCatalog, registerProxyRoutes } from "./proxy.js";
import { registerWebhookRoutes } from "./webhooks.js";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const modelsApiJsonPath = path.resolve(srcDir, "..", "models-site", "models", "api.json");
const isVercelRuntime = Boolean(process.env.VERCEL || process.env.VERCEL_ENV || process.env.VERCEL_URL);
const shouldServeLocalModelCatalog = !isVercelRuntime && (process.env.NODE_ENV !== "production" || process.env.OFFLINEGPT_DEV_MODE === "1");

const app = new Hono();

function healthPath(path: string) {
  return path === "/health" || path === "/ready";
}

app.use("*", async (c, next) => {
  const startedAt = Date.now();
  await next();
  if (healthPath(c.req.path)) return;
  const route = ["/api/v1/models", "/api/v1/chat/completions", "/webhooks/openrouter"].includes(c.req.path) ? c.req.path : "other";
  console.log("[inference-http]", { method: c.req.method, route, status: c.res.status, durationMs: Date.now() - startedAt });
});

if (env.corsOrigins.length > 0) {
  app.use(
    "*",
    cors({
      origin: env.corsOrigins,
      credentials: true,
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-Api-Key",
        "X-Webhook-Signature",
        "X-Test-Connection",
        "X-OfflineGpt-Session-Id",
        "X-OfflineGpt-Task-Id",
      ],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: ["X-OfflineGPT-Request-Id", "Retry-After"],
      maxAge: 600,
    }),
  );
}

app.get("/health", (c) => c.json({ ok: true, service: "inference" }));

app.get("/ready", async (c) => {
  try {
    await db.execute(sql`select 1`);
    return c.json({ ok: true, service: "inference", checks: { database: "ok" } });
  } catch (error) {
    console.error("[readiness] inference database check failed");
    return c.json({ ok: false, service: "inference", checks: { database: "error" } }, 503);
  }
});

if (env.selfHostedUpstream) {
  // Workspaces read their model list here (OPENCODE_MODELS_URL=<this>/models).
  const proxyBaseUrl = env.proxyBaseUrl ?? `http://127.0.0.1:${env.port}`;
  app.get("/models/api.json", async (c) => {
    try {
      const catalog = await defaultModelCatalog();
      c.header("Cache-Control", "no-store");
      return c.json(buildOpencodeModelsCatalog(catalog, proxyBaseUrl));
    } catch {
      console.error("[inference] self-hosted model catalog unavailable");
      return c.json({ error: "upstream_unreachable" }, 502);
    }
  });
} else if (shouldServeLocalModelCatalog) {
  app.get("/models/api.json", async (c) => {
    const body = await readFile(modelsApiJsonPath, "utf8");
    c.header("Content-Type", "application/json; charset=utf-8");
    c.header("Cache-Control", "no-store");
    return c.body(body);
  });
}

registerProxyRoutes(app);
registerWebhookRoutes(app);

app.onError((error, c) => {
  if (error instanceof z.ZodError) {
    return c.json({ error: "invalid_request", issues: error.issues }, 400);
  }
  console.error("[inference] request handling failed");
  return c.json({ error: "internal_server_error" }, 500);
});

export default app;
