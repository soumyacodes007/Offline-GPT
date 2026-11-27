import { createHash } from "node:crypto";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { KIND_BASELINES, loadRules, subjectOf } from "@offlinegpt-platform/access";
import { inferenceKeys, members, usageRecords, type Database } from "@offlinegpt-platform/db";
import { decide, decideMany, type Subject } from "@offlinegpt-platform/policy";
import { z } from "zod";
import type { ModelConfig } from "./config";
import { NO_USAGE, usageOf, watchStreamUsage, type Usage } from "./usage";

export type GatewayDeps = {
  db: Database;
  models: ModelConfig[];
  dailyTokenLimit: number | null;
  now: () => Date;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

type Caller = { memberId: string; subject: Subject };

function openAiError(c: Context, status: 400 | 401 | 403 | 404 | 429 | 502, code: string, message: string) {
  return c.json({ error: { message, type: code, code } }, status);
}

const chatSchema = z.looseObject({
  model: z.string().min(1),
  stream: z.boolean().optional(),
  stream_options: z.looseObject({}).optional(),
});

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** OpenCode's catalog entry for the self-hosted provider; the provider id matches the workspace config. */
export function modelCatalog(models: ModelConfig[]) {
  return {
    offlinegpt: {
      id: "offlinegpt",
      name: "OfflineGPT Models",
      npm: "@ai-sdk/openai-compatible",
      env: [],
      models: Object.fromEntries(models.map((model) => [model.alias, {
        id: model.alias,
        name: model.displayName,
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        release_date: "2026-01-01",
        last_updated: "2026-01-01",
        modalities: { input: ["text"], output: ["text"] },
        open_weights: true,
        cost: { input: 0, output: 0 },
        limit: { context: model.contextLength, output: Math.min(8192, Math.floor(model.contextLength / 4)) },
      }])),
    },
  };
}

export function createGateway(deps: GatewayDeps): Hono {
  const app = new Hono();
  const byAlias = new Map(deps.models.map((model) => [model.alias, model]));

  async function caller(c: Context): Promise<Caller | null> {
    const header = c.req.header("authorization") ?? "";
    const key = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!key) return null;
    const [row] = await deps.db
      .select({ id: members.id, role: members.role })
      .from(inferenceKeys)
      .innerJoin(members, eq(members.id, inferenceKeys.memberId))
      .where(and(eq(inferenceKeys.keyHash, createHash("sha256").update(key).digest("hex")), isNull(inferenceKeys.revokedAt), eq(members.active, true)))
      .limit(1);
    return row ? { memberId: row.id, subject: await subjectOf(deps.db, row) } : null;
  }

  async function record(memberId: string, model: string, usage: Usage, status: "completed" | "failed") {
    await deps.db.insert(usageRecords).values({ at: deps.now(), memberId, model, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, status });
  }

  async function tokensToday(memberId: string): Promise<number> {
    const [row] = await deps.db
      .select({ total: sql<number>`coalesce(sum(coalesce(${usageRecords.promptTokens}, 0) + coalesce(${usageRecords.completionTokens}, 0)), 0)::int` })
      .from(usageRecords)
      .where(and(eq(usageRecords.memberId, memberId), gte(usageRecords.at, startOfUtcDay(deps.now()))));
    return row?.total ?? 0;
  }

  app.get("/health", (c) => c.json({ ok: true }));

  /**
   * The model catalog OpenCode reads (models.dev format) at OPENCODE_MODELS_URL/api.json.
   * It only describes the configured models; who may use them is checked on each call.
   */
  app.get("/models/api.json", (c) => c.json(modelCatalog(deps.models)));

  app.get("/v1/models", async (c) => {
    const who = await caller(c);
    if (!who) return openAiError(c, 401, "invalid_api_key", "This key is not valid. Get a new one from your workspace settings.");
    const decisions = decideMany({ subject: who.subject, kind: "model", ids: deps.models.map((model) => model.alias), rules: await loadRules(deps.db, "model"), baseline: KIND_BASELINES.model, now: deps.now() });
    const data = deps.models
      .filter((model) => decisions.get(model.alias)?.allowed)
      .map((model) => ({ id: model.alias, object: "model", owned_by: "offlinegpt", name: model.displayName, context_length: model.contextLength }));
    return c.json({ object: "list", data });
  });

  app.post("/v1/chat/completions", async (c) => {
    const who = await caller(c);
    if (!who) return openAiError(c, 401, "invalid_api_key", "This key is not valid. Get a new one from your workspace settings.");
    const parsed = chatSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return openAiError(c, 400, "invalid_request", "The request body must be a chat completion request with a model.");
    const body = parsed.data;
    const model = byAlias.get(body.model);
    if (!model) return openAiError(c, 404, "model_not_found", `There is no model called "${body.model}".`);

    const decision = decide({ subject: who.subject, resource: { kind: "model", id: model.alias }, rules: await loadRules(deps.db, "model"), baseline: KIND_BASELINES.model, now: deps.now() });
    if (!decision.allowed) return openAiError(c, 403, "model_not_allowed", `You don't have access to ${model.displayName}. Request access from your workspace's "My access" page.`);
    if (deps.dailyTokenLimit !== null && (await tokensToday(who.memberId)) >= deps.dailyTokenLimit) {
      return openAiError(c, 429, "daily_limit_reached", "You have used today's token allowance. It resets at midnight UTC.");
    }

    const streaming = body.stream === true;
    const upstreamBody = { ...body, model: model.upstreamModel, ...(streaming ? { stream_options: { ...body.stream_options, include_usage: true } } : {}) };
    let upstream: Response;
    try {
      upstream = await deps.fetch(`${model.upstreamUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(model.upstreamApiKey ? { authorization: `Bearer ${model.upstreamApiKey}` } : {}) },
        body: JSON.stringify(upstreamBody),
        signal: c.req.raw.signal,
      });
    } catch {
      await record(who.memberId, model.alias, NO_USAGE, "failed");
      return openAiError(c, 502, "upstream_unreachable", `${model.displayName} isn't reachable right now. Try again shortly.`);
    }

    const headers = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json" });
    if (!upstream.ok || !upstream.body) {
      await record(who.memberId, model.alias, NO_USAGE, "failed");
      return new Response(upstream.body, { status: upstream.status, headers });
    }
    if (streaming) {
      const watched = upstream.body.pipeThrough(watchStreamUsage((usage, completed) => record(who.memberId, model.alias, usage, completed ? "completed" : "failed")));
      headers.set("cache-control", "no-cache");
      return new Response(watched, { status: upstream.status, headers });
    }
    const text = await upstream.text();
    let usage: Usage = NO_USAGE;
    try {
      usage = usageOf(JSON.parse(text)) ?? NO_USAGE;
    } catch {
      usage = NO_USAGE;
    }
    await record(who.memberId, model.alias, usage, "completed");
    return new Response(text, { status: upstream.status, headers });
  });

  return app;
}
