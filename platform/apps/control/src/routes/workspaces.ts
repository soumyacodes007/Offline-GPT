import type { Hono } from "hono";
import type { Deps } from "../deps";
import { access, fail, type AppEnv } from "../http";
import { WORKSPACE_PORT } from "../workspaces/service";
import { audit } from "../audit";

/** Request headers the container must never see: the member's own credentials and hop-by-hop headers. */
const DROPPED_HEADERS = ["authorization", "cookie", "host", "connection", "content-length", "transfer-encoding"];
const TOUCH_INTERVAL_MS = 60_000;

export function registerWorkspaceRoutes(app: Hono<AppEnv>, deps: Deps) {
  const service = deps.workspaces;
  const lastTouch = new Map<string, number>();

  app.get("/v1/me/workspace", access(deps, "member"), async (c) => {
    if (!service) fail(404, "workspaces_disabled", "Workspaces are not set up on this deployment.");
    const workspace = await service.get(c.get("member").id);
    return c.json({ workspace: workspace ? { status: workspace.status, url: "/w/" } : null });
  });

  app.post("/v1/me/workspace", access(deps, "member"), async (c) => {
    if (!service) fail(404, "workspaces_disabled", "Workspaces are not set up on this deployment.");
    const member = c.get("member");
    const workspace = await service.ensure(member.id);
    await audit(deps, member.id, "workspace.started", { container: workspace.containerName });
    return c.json({ workspace: { status: workspace.status, url: "/w/" } });
  });

  /** Everything under /w/ goes to the signed-in member's own container, and only theirs. */
  app.all("/w/*", access(deps, "member"), async (c) => {
    if (!service) fail(404, "workspaces_disabled", "Workspaces are not set up on this deployment.");
    const member = c.get("member");
    const workspace = await service.get(member.id);
    if (!workspace || workspace.status !== "running") fail(409, "workspace_not_running", "Start your workspace first.");

    const incoming = new URL(c.req.url);
    const target = `http://${workspace.containerName}:${WORKSPACE_PORT}${incoming.pathname.slice(2) || "/"}${incoming.search}`;
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
      return c.json({ error: "workspace_unreachable", message: "Your workspace is starting or not responding. Try again in a moment." }, 502);
    }
  });
}
