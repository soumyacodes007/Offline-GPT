import { Hono, type Context } from "hono";
import { audit } from "../audit";
import type { Deps } from "../deps";
import { getCookie } from "hono/cookie";
import { access, fail, readJson, SESSION_COOKIE, type AppEnv } from "../http";
import { resolveSession, type Member } from "../sessions";
import { readWorkspacePolicy, workspacePolicySchema, writeWorkspacePolicy } from "../workspaces/policy";
import { WORKSPACE_PORT, type WorkspaceService } from "../workspaces/service";

/** Request headers the container must never see: the member's own credentials and hop-by-hop headers. */
const DROPPED_HEADERS = ["authorization", "cookie", "host", "connection", "content-length", "transfer-encoding"];
const TOUCH_INTERVAL_MS = 60_000;
const STARTING_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="2"><title>Starting your workspace</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#334155;background:#f8fafc}</style></head>
<body><p>Starting your workspace… this page refreshes by itself.</p></body></html>`;

function createForwarder(deps: Deps, service: WorkspaceService) {
  const lastTouch = new Map<string, number>();
  return async (c: Context, member: Member, path: string): Promise<Response> => {
    const workspace = await service.get(member.id);
    if (!workspace || workspace.status !== "running") fail(409, "workspace_not_running", "Start your workspace first.");
    const incoming = new URL(c.req.url);
    const target = `http://${workspace.containerName}:${WORKSPACE_PORT}${path}${incoming.search}`;
    const headers = new Headers(c.req.raw.headers);
    for (const name of DROPPED_HEADERS) headers.delete(name);
    headers.set("authorization", `Bearer ${workspace.token}`);
    const nowMs = deps.now().getTime();
    if (nowMs - (lastTouch.get(member.id) ?? 0) > TOUCH_INTERVAL_MS) {
      lastTouch.set(member.id, nowMs);
      await service.touch(member.id);
    }
    const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
    try {
      const upstream = await deps.fetch(target, { method: c.req.method, headers, ...(hasBody ? { body: c.req.raw.body, duplex: "half" } : {}), redirect: "manual", signal: c.req.raw.signal });
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.delete("set-cookie");
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    } catch {
      // A browser opening the page gets a page that retries by itself while the container starts.
      if (c.req.method === "GET" && (c.req.header("accept") ?? "").includes("text/html")) return c.html(STARTING_PAGE, 503);
      return c.json({ error: "workspace_unreachable", message: "Your workspace is starting or not responding. Try again in a moment." }, 502);
    }
  };
}

export function registerWorkspaceRoutes(app: Hono<AppEnv>, deps: Deps) {
  const service = deps.workspaces;
  const forward = service ? createForwarder(deps, service) : null;

  app.get("/v1/settings/workspace-policy", access(deps, { permission: "access" }), async (c) => c.json({ policy: await readWorkspacePolicy(deps.db) }));

  app.put("/v1/settings/workspace-policy", access(deps, { permission: "access" }), async (c) => {
    const policy = await readJson(c, workspacePolicySchema);
    await writeWorkspacePolicy(deps.db, policy);
    await audit(deps, c.get("member").id, "workspace.policy_changed", policy);
    // Running workspaces take it now; the rest get it when they next start.
    const missed = deps.workspaces ? await deps.workspaces.applyPolicy() : 0;
    return c.json({ policy, missed });
  });

  app.get("/v1/me/workspace", access(deps, "member"), async (c) => {
    if (!service) fail(404, "workspaces_disabled", "Workspaces are not set up on this deployment.");
    const workspace = await service.get(c.get("member").id);
    return c.json({ workspace: workspace ? { status: workspace.status, url: deps.config.workspaceUrl?.toString() ?? "/w/" } : null });
  });

  app.post("/v1/me/workspace", access(deps, "member"), async (c) => {
    if (!service) fail(404, "workspaces_disabled", "Workspaces are not set up on this deployment.");
    const member = c.get("member");
    const workspace = await service.ensure(member.id);
    await audit(deps, member.id, "workspace.started", { container: workspace.containerName });
    return c.json({ workspace: { status: workspace.status, url: deps.config.workspaceUrl?.toString() ?? "/w/" } });
  });

  /** API access to the signed-in member's own container under /w/. */
  app.all("/w/*", access(deps, "member"), async (c) => {
    if (!forward) fail(404, "workspaces_disabled", "Workspaces are not set up on this deployment.");
    return forward(c, c.get("member"), new URL(c.req.url).pathname.slice(2) || "/");
  });
}

/**
 * The workspace origin: every path goes to the signed-in member's own
 * container, which serves the workspace app. Served on its own port because
 * the app uses root-relative paths. Cookies are shared across ports of one
 * host, so the console sign-in covers it.
 */
export function createWorkspaceOrigin(deps: Deps, service: WorkspaceService): Hono {
  const app = new Hono();
  const forward = createForwarder(deps, service);
  app.all("/*", async (c) => {
    // Only the sign-in cookie counts here: the app sends its container's token
    // as Authorization, and the forwarder replaces that header anyway.
    const token = getCookie(c, SESSION_COOKIE);
    const member = token ? await resolveSession(deps, token) : null;
    if (!member) return c.redirect(deps.config.publicUrl.toString(), 302);
    const workspace = await service.get(member.id);
    if (!workspace || workspace.status !== "running") {
      await service.ensure(member.id);
      await audit(deps, member.id, "workspace.started", { via: "workspace-origin" });
    }
    return forward(c, member, c.req.path);
  });
  app.onError((error, c) => {
    console.error(JSON.stringify({ level: "error", service: "control", message: "workspace origin error", error: error.message }));
    return c.json({ error: "workspace_error", message: "Your workspace could not be opened. Try again shortly." }, 502);
  });
  return app;
}
