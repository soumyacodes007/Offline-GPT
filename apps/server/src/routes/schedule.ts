import { timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import { ApiError } from "../errors.js";
import { ScheduleConflictError, ScheduleNotFoundError, type ScheduleService } from "../schedule/service.js";
import { ScheduleInputError } from "../schedule/timing.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;

/** Map Schedule's own errors onto API errors; everything else propagates. */
async function scheduleCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ScheduleInputError) throw new ApiError(400, error.code, error.message);
    if (error instanceof ZodError) throw new ApiError(400, "invalid_payload", error.issues[0]?.message ?? "Invalid scheduled task", { issues: error.issues });
    if (error instanceof ScheduleNotFoundError) throw new ApiError(404, "schedule_not_found", error.message);
    if (error instanceof ScheduleConflictError) throw new ApiError(409, "schedule_conflict", error.message);
    throw error;
  }
}

export function registerScheduleRoutes(options: {
  routes: Route[];
  config: ServerConfig;
  service: ScheduleService;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}): void {
  const { routes, config, service, jsonResponse, readJsonBody, ensureWritable, requireClientScope, resolveWorkspace } = options;
  const writable = async (ctx: RequestContext) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    return resolveWorkspace(config, ctx.params.id);
  };

  addRoute(routes, "GET", "/workspace/:id/schedule", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const active = ctx.url.searchParams.get("active");
    return jsonResponse(await scheduleCall(() => service.list(workspace.id, active === null ? {} : { active: active === "true" })));
  });

  addRoute(routes, "POST", "/workspace/:id/schedule", "client", async (ctx) => {
    const workspace = await writable(ctx);
    const body = await readJsonBody(ctx.request);
    return jsonResponse(await scheduleCall(() => service.create(workspace.id, body)), 201);
  });

  addRoute(routes, "DELETE", "/workspace/:id/schedule/ended", "client", async (ctx) => {
    const workspace = await writable(ctx);
    return jsonResponse(await scheduleCall(() => service.deleteEnded(workspace.id)));
  });

  addRoute(routes, "GET", "/workspace/:id/schedule/:taskId", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse(await scheduleCall(() => service.view(workspace.id, ctx.params.taskId)));
  });

  addRoute(routes, "PATCH", "/workspace/:id/schedule/:taskId", "client", async (ctx) => {
    const workspace = await writable(ctx);
    const body = await readJsonBody(ctx.request);
    return jsonResponse(await scheduleCall(() => service.update(workspace.id, ctx.params.taskId, body)));
  });

  addRoute(routes, "DELETE", "/workspace/:id/schedule/:taskId", "client", async (ctx) => {
    const workspace = await writable(ctx);
    return jsonResponse(await scheduleCall(() => service.remove(workspace.id, ctx.params.taskId)));
  });

  addRoute(routes, "POST", "/workspace/:id/schedule/:taskId/run", "client", async (ctx) => {
    const workspace = await writable(ctx);
    return jsonResponse(await scheduleCall(() => service.run(workspace.id, ctx.params.taskId)));
  });
}

/**
 * The engine's schedule tools call this with the per-boot plugin token. The
 * workspace always comes from the calling chat, never from tool input, so a
 * prompt cannot reach another workspace's tasks.
 */
export function registerSchedulePluginRoute(options: {
  routes: Route[];
  service: ScheduleService;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  pluginToken: () => string;
  workspaceForSession: (sessionID: string) => Promise<WorkspaceInfo>;
}): void {
  const { routes, service, jsonResponse, readJsonBody } = options;
  addRoute(routes, "POST", "/internal/v2-plugin/schedule", "none", async (ctx) => {
    const presented = Buffer.from(ctx.request.headers.get("x-offlinegpt-plugin-token") ?? "");
    const expected = Buffer.from(options.pluginToken());
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      throw new ApiError(401, "unauthorized", "Missing or invalid plugin token");
    }
    const body = await readJsonBody(ctx.request);
    const sessionID = typeof body.sessionID === "string" ? body.sessionID : "";
    if (!sessionID) throw new ApiError(400, "invalid_payload", "sessionID is required");
    const workspace = await options.workspaceForSession(sessionID);
    const id = typeof body.id === "string" ? body.id : "";
    return jsonResponse(await scheduleCall(async () => {
      switch (body.action) {
        case "create":
          // An omitted target means "this chat": a reminder lands where it was asked for.
          return service.create(workspace.id, { ...(isRecord(body.request) ? body.request : {}), target: isRecord(body.request) && isRecord(body.request.target) ? body.request.target : { kind: "session", session_id: sessionID } });
        case "list":
          return service.list(workspace.id, typeof body.active === "boolean" ? { active: body.active } : {});
        case "view":
          return service.view(workspace.id, id);
        case "update":
          return service.update(workspace.id, id, body.request);
        case "delete":
          return service.remove(workspace.id, id);
        case "run":
          return service.run(workspace.id, id);
        default:
          throw new ApiError(400, "invalid_payload", "action must be create, list, view, update, delete, or run");
      }
    }));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
