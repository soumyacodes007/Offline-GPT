// `workflow` tool for the OpenCode v2 engine: the model writes a short
// JavaScript orchestration script whose `agent()` calls run as child sessions.
// Design follows deepseek-harness's dsh-workflow (MIT): meta is validated and
// the script compiled before a run exists, caps and cancellation end the run
// loudly, and the run resolves (never rejects) with a stop reason.
import vm from "node:vm";
import { z } from "zod";

export const workflowMetaSchema = z.object({
  name: z.string().trim().min(1).describe("Short kebab-case workflow name."),
  description: z.string().trim().min(1).describe("One-line description of what the workflow does."),
  whenToUse: z.string().optional().describe("Optional guidance on when this workflow applies."),
  phases: z
    .array(z.object({ title: z.string().min(1), detail: z.string().optional() }))
    .optional()
    .describe("Optional phase declarations matched by phase() calls."),
});

export type WorkflowMeta = z.infer<typeof workflowMetaSchema>;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type WorkflowResult = {
  value: JsonValue;
  stopReason: "completed" | "cancelled" | "error";
  error?: string;
  agentsStarted: number;
  logs: string[];
};

export type AgentRequest = { prompt: string; title?: string; signal: AbortSignal };

/** Runs one subagent to completion and returns its final text; throws when the child fails. */
export type SpawnAgent = (request: AgentRequest) => Promise<string>;

export type RunWorkflowOptions = {
  script: string;
  meta: unknown;
  args?: unknown;
  spawnAgent: SpawnAgent;
  signal?: AbortSignal;
  maxTotalAgents?: number;
  maxConcurrency?: number;
  timeoutMs?: number;
};

const agentRequestSchema = z.union([
  z.string().min(1).transform((prompt) => ({ prompt, title: undefined })),
  z.object({ prompt: z.string().min(1), title: z.string().optional() }).strict(),
]);

const MAX_LOGS = 200;
const MAX_LOG_CHARS = 2_000;
// Only bounds the script's synchronous start; awaited work is bounded by timeoutMs.
const SYNC_TIMEOUT_MS = 5_000;
const CHILD_SETTLE_MS = 10_000;

// Runs inside the context. Host functions stay captured in this closure and
// only strings cross the boundary, so the script never holds a host object
// (whose `.constructor` would lead back to the host realm).
const BOOTSTRAP = `(function install(bridge, argsJson) {
  "use strict";
  const callAgent = bridge.agent, emit = bridge.log, enterPhase = bridge.phase;
  const render = (value) => {
    if (typeof value === "string") return value;
    try { const text = JSON.stringify(value); return text === undefined ? String(value) : text; } catch { return String(value); }
  };
  const line = (...values) => emit(values.map(render).join(" "));
  Object.defineProperty(globalThis, "console", { value: Object.freeze({ log: line, info: line, warn: line, error: line, debug: line }) });
  Object.defineProperty(globalThis, "args", { value: argsJson === undefined ? undefined : JSON.parse(argsJson) });
  Object.defineProperty(globalThis, "phase", { value: (title) => { enterPhase(render(title)); } });
  Object.defineProperty(globalThis, "agent", {
    value: (request) => new Promise((resolve, reject) => {
      let payload;
      try { payload = JSON.stringify(request === undefined ? null : request); } catch { payload = "null"; }
      callAgent(payload, (text) => resolve(text), (message) => reject(new Error(message)));
    }),
  });
  return (value) => {
    if (value === undefined) return "null";
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError("workflow return value is not JSON-serializable");
    return text;
  };
})`;

function renderThrown(error: unknown): string {
  try {
    if (error instanceof Error) return error.message;
    if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
      return error.message;
    }
    return String(error);
  } catch {
    return "[unrenderable thrown value]";
  }
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

/** Re-parse host-side so the result holds no object from the script realm. */
function parseJson(text: string): JsonValue {
  const parsed: unknown = JSON.parse(text);
  return z.json().parse(parsed);
}

class FatalWorkflowError extends Error {}

export async function runWorkflow(options: RunWorkflowOptions): Promise<WorkflowResult> {
  const maxTotalAgents = options.maxTotalAgents ?? 16;
  const maxConcurrency = options.maxConcurrency ?? 4;
  const timeoutMs = options.timeoutMs ?? 20 * 60_000;
  const logs: string[] = [];
  let agentsStarted = 0;
  const result = (stopReason: WorkflowResult["stopReason"], value: JsonValue, error?: string): WorkflowResult => ({
    value,
    stopReason,
    ...(error === undefined ? {} : { error }),
    agentsStarted,
    logs,
  });

  const meta = workflowMetaSchema.safeParse(options.meta);
  if (!meta.success) return result("error", null, `invalid workflow meta: ${z.prettifyError(meta.error)}`);
  let argsJson: string | undefined;
  try {
    argsJson = options.args === undefined ? undefined : JSON.stringify(options.args);
  } catch {
    return result("error", null, "workflow args must be JSON-serializable");
  }
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  // Evaluating the function expression parses the script without running it
  // (Bun's vm.Script defers syntax errors until it runs).
  let body: unknown;
  try {
    body = vm.runInContext(`(async function () {\n${options.script}\n})`, context, {
      filename: `workflow-${meta.data.name}.js`,
      timeout: SYNC_TIMEOUT_MS,
    });
  } catch (error) {
    return result("error", null, `workflow script does not parse: ${renderThrown(error)}`);
  }
  if (!isFunction(body)) return result("error", null, "workflow script must be a plain function body");
  if (options.signal?.aborted) return result("cancelled", null, "workflow was cancelled before it started");

  const run = new AbortController();
  let stop: { reason: "cancelled" | "error"; message: string } | undefined;
  let rejectStopped: (error: Error) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  stopped.catch(() => {});
  const halt = (reason: "cancelled" | "error", message: string) => {
    if (stop) return;
    stop = { reason, message };
    run.abort();
    rejectStopped(new FatalWorkflowError(message));
  };
  const onAbort = () => halt("cancelled", "workflow was cancelled");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => halt("error", `workflow timed out after ${timeoutMs} ms`), timeoutMs);

  const pushLog = (text: string) => {
    if (logs.length < MAX_LOGS) logs.push(text.slice(0, MAX_LOG_CHARS));
  };
  const inFlight = new Set<Promise<void>>();
  const queue: Array<() => void> = [];
  let running = 0;
  let calls = 0;
  // A freed slot passes straight to the next queued agent, so `running` never exceeds the limit.
  const acquire = () => {
    if (running < maxConcurrency) {
      running += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => queue.push(resolve));
  };
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else running -= 1;
  };
  const startAgent = async (prompt: string, title: string | undefined): Promise<string | null> => {
    await acquire();
    try {
      if (run.signal.aborted) throw new FatalWorkflowError("workflow stopped");
      agentsStarted += 1;
      return await options.spawnAgent({ prompt, title, signal: run.signal });
    } catch (error) {
      if (run.signal.aborted) throw error;
      pushLog(`[agent ${title ?? agentsStarted}] failed: ${renderThrown(error)}`);
      return null;
    } finally {
      release();
    }
  };

  const bridge = {
    agent(payload: unknown, resolve: unknown, reject: unknown) {
      if (!isFunction(resolve) || !isFunction(reject) || typeof payload !== "string") return;
      const request = agentRequestSchema.safeParse(JSON.parse(payload));
      if (!request.success) {
        const message = `agent() expects { prompt: string, title?: string }: ${z.prettifyError(request.error)}`;
        halt("error", message);
        reject(message);
        return;
      }
      calls += 1;
      if (calls > maxTotalAgents) {
        const message = `workflow exceeded maxTotalAgents (${maxTotalAgents}); split the work into fewer agent() calls`;
        halt("error", message);
        reject(message);
        return;
      }
      const task = startAgent(request.data.prompt, request.data.title).then(
        (text) => void resolve(text),
        (error: unknown) => void reject(renderThrown(error)),
      );
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    },
    log(text: unknown) {
      pushLog(String(text));
    },
    phase(title: unknown) {
      pushLog(`[phase] ${String(title)}`);
    },
  };

  try {
    const install: unknown = vm.runInContext(BOOTSTRAP, context);
    if (!isFunction(install)) throw new Error("workflow bootstrap failed");
    const serialize = install(bridge, argsJson);
    if (!isFunction(serialize)) throw new Error("workflow bootstrap failed");
    // Start through vm so the script's synchronous part is under the timeout;
    // the hand-off global is gone before any script code runs.
    Object.defineProperty(context, "__workflowBody", { value: body, configurable: true });
    const completion: unknown = vm.runInContext(
      "(() => { const body = globalThis.__workflowBody; delete globalThis.__workflowBody; return body(); })()",
      context,
      { timeout: SYNC_TIMEOUT_MS },
    );
    const value = await Promise.race([completion, stopped]);
    if (stop) return result(stop.reason, null, stop.message);
    const text = serialize(value);
    if (typeof text !== "string") throw new Error("workflow return value is not JSON-serializable");
    return result("completed", parseJson(text));
  } catch (error) {
    if (stop) return result(stop.reason, null, stop.message);
    return result("error", null, renderThrown(error));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    // Agents the script never awaited must not outlive the run.
    run.abort();
    for (const resolveQueued of queue.splice(0)) resolveQueued();
    if (inFlight.size > 0) {
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise((resolve) => setTimeout(resolve, CHILD_SETTLE_MS).unref?.()),
      ]);
    }
  }
}

export const WORKFLOW_TOOL_DESCRIPTION = `Run a JavaScript orchestration script that fans work out to subagents and returns the script's final JSON value. Use it only when the work splits into independent parts (several files, sources or angles) that can run in parallel; for a single delegation just do the work yourself.

The script is a plain JavaScript async function body (top-level await allowed) and must end with \`return <JSON value>\`. Available inside it:
- \`await agent({ prompt, title? })\` starts a subagent in this workspace and resolves with its final text, or null if that subagent failed. Subagents see none of this chat, so each prompt must be self-contained.
- \`phase(title)\` reports progress; \`console.log(...)\` adds to the returned logs.
- \`args\` is the JSON passed in this call's \`args\` field.
There is no filesystem, network, timer, require or process access in the script itself; the subagents do the work. At most 16 agents per run, 4 at a time (the rest queue).

Example:
phase("Review");
const reviews = await Promise.all(args.files.map((file) =>
  agent({ title: file, prompt: \`Review \${file} for bugs. Reply with a short bullet list.\` })
));
phase("Summarize");
const summary = await agent({ prompt: "Merge these reviews into one prioritized list:\\n" + reviews.filter(Boolean).join("\\n---\\n") });
return { summary, reviewed: reviews.length };`;

export const workflowToolInputSchema = z.object({
  script: z.string().min(1).describe("Plain JavaScript async function body ending with `return <JSON value>`."),
  meta: workflowMetaSchema.describe("Workflow identity as plain JSON."),
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Optional JSON object exposed to the script as `args` (wrap a list as a field, e.g. {"files": [...]}).'),
});

type ContextMessage = {
  type: string;
  time: { created: number };
  outcome?: string;
  error?: { message?: string };
  content?: Array<{ type: string; text?: string }>;
};

/** The slice of the v2 plugin `ctx.session` API that subagents need. */
export type WorkflowSessionApi = {
  get(input: { sessionID: string }): Promise<{ model?: { id: string; providerID: string; variant?: string } }>;
  create(input: {
    parentID: string;
    title?: string;
    model?: { id: string; providerID: string; variant?: string };
  }): Promise<{ id: string }>;
  prompt(input: { sessionID: string; text: string }): Promise<{ time: { created: number } }>;
  wait(input: { sessionID: string }): Promise<unknown>;
  context(input: { sessionID: string }): Promise<ContextMessage[]>;
  interrupt(input: { sessionID: string }): Promise<unknown>;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Child sessions inherit the parent's location; they also use its model. A
 * turn is over once an idle marker newer than our prompt is in the context.
 */
export function createSessionSpawner(session: WorkflowSessionApi, parentSessionID: string): SpawnAgent {
  let parent: ReturnType<WorkflowSessionApi["get"]> | undefined;
  return async ({ prompt, title, signal }) => {
    parent ??= session.get({ sessionID: parentSessionID });
    const { model } = await parent;
    const child = await session.create({
      parentID: parentSessionID,
      title: title ?? "Workflow agent",
      ...(model === undefined ? {} : { model }),
    });
    const interrupt = () => void session.interrupt({ sessionID: child.id }).catch(() => {});
    signal.addEventListener("abort", interrupt, { once: true });
    try {
      const sent = await session.prompt({
        sessionID: child.id,
        text: `You are a subagent spawned by another session.\n${prompt}`,
      });
      for (;;) {
        await session.wait({ sessionID: child.id });
        if (signal.aborted) throw new Error("workflow stopped");
        const messages = (await session.context({ sessionID: child.id })).filter(
          (message) => message.time.created >= sent.time.created,
        );
        const newestFirst = [...messages].reverse();
        const idle = newestFirst.find((message) => message.type === "idle");
        if (idle) {
          if (idle.outcome !== "succeeded") throw new Error(idle.error?.message ?? `subagent ${idle.outcome}`);
          const reply = newestFirst.find((message) => message.type === "assistant");
          return (reply?.content ?? [])
            .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
            .join("\n");
        }
        // wait() can return before the prompt's turn has been scheduled.
        await delay(500);
      }
    } finally {
      signal.removeEventListener("abort", interrupt);
    }
  };
}

type ToolContext = { sessionID: string; signal: AbortSignal };

export function createWorkflowTool(session: WorkflowSessionApi) {
  return {
    name: "workflow",
    description: WORKFLOW_TOOL_DESCRIPTION,
    input: workflowToolInputSchema,
    async execute(input: unknown, context: ToolContext): Promise<{ content: string }> {
      const call = workflowToolInputSchema.parse(input);
      const outcome = await runWorkflow({
        script: call.script,
        meta: call.meta,
        args: call.args,
        spawnAgent: createSessionSpawner(session, context.sessionID),
        signal: context.signal,
      });
      return { content: JSON.stringify(outcome, null, 2) };
    },
  };
}
