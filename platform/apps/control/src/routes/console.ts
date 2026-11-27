import { resolve, sep } from "node:path";
import type { Hono } from "hono";
import type { Deps } from "../deps";
import { access, type AppEnv } from "../http";

const API_PREFIXES = ["/v1/", "/auth/", "/scim/", "/w/", "/mcp", "/setup", "/health"];

/** Serve the built console. Unknown paths get index.html so the app can route itself. Registered last. */
export function registerConsoleRoutes(app: Hono<AppEnv>, deps: Deps, dir: string) {
  const root = resolve(dir);
  app.get("/*", access(deps, "public"), async (c) => {
    const path = c.req.path;
    if (API_PREFIXES.some((prefix) => path.startsWith(prefix))) return c.json({ error: "not_found", message: "No such route." }, 404);
    const candidate = resolve(root, `.${decodeURIComponent(path)}`);
    const inside = candidate === root || candidate.startsWith(root + sep);
    const file = inside && path !== "/" ? Bun.file(candidate) : null;
    if (file && (await file.exists())) {
      return new Response(file, { headers: { "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" } });
    }
    return new Response(Bun.file(resolve(root, "index.html")), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  });
}
