import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Deps } from "./deps";
import { access, type AppEnv } from "./http";
import { registerAuditRoutes } from "./routes/audit";
import { registerAuthRoutes } from "./routes/auth";
import { registerInferenceRoutes } from "./routes/inference";
import { registerOidcRoutes } from "./routes/oidc";
import { registerRequestRoutes } from "./routes/requests";
import { registerRuleRoutes } from "./routes/rules";
import { registerScimRoutes } from "./routes/scim";
import { registerWorkspaceRoutes } from "./routes/workspaces";

export function createApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/health", access(deps, "public"), (c) => c.json({ ok: true }));
  registerAuthRoutes(app, deps);
  registerOidcRoutes(app, deps);
  registerScimRoutes(app, deps);
  registerRuleRoutes(app, deps);
  registerRequestRoutes(app, deps);
  registerAuditRoutes(app, deps);
  registerInferenceRoutes(app, deps);
  registerWorkspaceRoutes(app, deps);

  app.notFound((c) => c.json({ error: "not_found", message: "No such route." }, 404));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    console.error(JSON.stringify({ level: "error", service: "control", message: "Unhandled error", error: error.message, path: c.req.path }));
    return c.json({ error: "internal", message: "Something went wrong." }, 500);
  });
  return app;
}
