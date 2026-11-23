import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DateTime } from "luxon";
import {
  scheduleCreateSchema,
  scheduleUpdateSchema,
  type ScheduleDelivery,
  type ScheduleTask,
  type ScheduleTiming,
} from "@offlinegpt/types/schedule";
import { runtimeStorageDir } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";
import { firstOccurrence, nextOccurrence, ScheduleInputError, validateTiming } from "./timing.js";

/** Stored rows add the interval anchor that keeps `every` aligned across edits. */
type StoredTask = ScheduleTask & { anchorAt: string };
type StoredFile = { version: 1; tasks: StoredTask[] };

export type ScheduleDeliveryRequest = {
  task: ScheduleTask;
  /** An existing chat to write into, or null to create one titled after the task. */
  sessionId: string | null;
};
export type ScheduleDeliveryPort = {
  /** Write the prompt as a message; resolves with the chat it landed in. */
  deliver(request: ScheduleDeliveryRequest): Promise<{ sessionId: string }>;
  /** True while the chat is mid-turn, so a reused chat is not interrupted. */
  isBusy(workspaceId: string, sessionId: string): Promise<boolean>;
  sessionExists(workspaceId: string, sessionId: string): Promise<boolean>;
};

/** Per-task minimum spacing between deliveries, as in DeepSeek Harness. */
const MIN_DELIVERY_SPACING_MS = 60_000;
const HISTORY_LIMIT = 200;
const HISTORY_MAX_AGE_MS = 30 * 24 * 3600_000;
const TICK_MS = 15_000;

function utc(value: DateTime): string {
  return value.toUTC().toISO() ?? new Date(value.toMillis()).toISOString();
}

function publicTask(task: StoredTask): ScheduleTask {
  const { anchorAt: _anchor, ...visible } = task;
  return visible;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredTask(value: unknown): value is StoredTask {
  return isRecord(value) && typeof value.id === "string" && typeof value.workspaceId === "string"
    && typeof value.anchorAt === "string" && isRecord(value.timing) && isRecord(value.target) && Array.isArray(value.history);
}

function pruneHistory(history: ScheduleDelivery[], now: number): ScheduleDelivery[] {
  const recent = history.filter((entry, index) => index === 0 || now - Date.parse(entry.deliveredAt) <= HISTORY_MAX_AGE_MS);
  return recent.slice(0, HISTORY_LIMIT);
}

export class ScheduleConflictError extends Error {}
export class ScheduleNotFoundError extends Error {}

export function createScheduleService(input: {
  config: ServerConfig;
  port: ScheduleDeliveryPort;
  now?: () => DateTime;
  log?: (message: string, attributes?: Record<string, unknown>) => void;
}) {
  const path = join(runtimeStorageDir(input.config), "schedule.json");
  const now = input.now ?? (() => DateTime.utc());
  const log = input.log ?? (() => undefined);
  let tasks: StoredTask[] | null = null;
  // Reads, edits and deliveries share one FIFO so a delivery never races an edit.
  let queue: Promise<unknown> = Promise.resolve();
  const executing = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  async function load(): Promise<StoredTask[]> {
    if (tasks) return tasks;
    let loaded: StoredTask[];
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      const rows = isRecord(parsed) && Array.isArray(parsed.tasks) ? parsed.tasks : null;
      // A malformed file must not silently become an empty schedule that the next save overwrites.
      if (!rows) throw new Error(`${path} has no task list`);
      loaded = rows.filter(isStoredTask);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      loaded = [];
    }
    tasks = loaded;
    return loaded;
  }

  async function save(): Promise<void> {
    const file: StoredFile = { version: 1, tasks: await load() };
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  }

  async function find(workspaceId: string, id: string): Promise<StoredTask> {
    const task = (await load()).find((entry) => entry.id === id && entry.workspaceId === workspaceId);
    if (!task) throw new ScheduleNotFoundError(`Scheduled task ${id} was not found.`);
    return task;
  }

  async function checkTarget(workspaceId: string, target: ScheduleTask["target"]): Promise<void> {
    if (target.kind === "session" && !await input.port.sessionExists(workspaceId, target.session_id)) {
      throw new ScheduleInputError("unknown_session", `Chat ${target.session_id} does not exist in this workspace.`);
    }
  }

  function arm(timing: ScheduleTiming, at: DateTime): { nextRunAt: string; anchorAt: string } {
    return { nextRunAt: utc(validateTiming(timing, at, at)), anchorAt: utc(at) };
  }

  async function deliver(task: StoredTask, scheduledAt: string, manual: boolean): Promise<void> {
    const reuse = task.target.kind === "session" ? task.target.session_id : task.target.kind === "new_once" ? task.reservedSessionId : null;
    const deliveredAt = utc(now());
    let entry: ScheduleDelivery;
    try {
      let sessionId = reuse;
      if (sessionId && !await input.port.sessionExists(task.workspaceId, sessionId)) {
        // A deleted reserved chat is replaced; a deleted explicit target fails loudly.
        if (task.target.kind === "session") throw new Error(`Target chat ${sessionId} no longer exists.`);
        sessionId = null;
      }
      const result = await input.port.deliver({ task: publicTask(task), sessionId });
      if (task.target.kind === "new_once") task.reservedSessionId = result.sessionId;
      entry = { scheduledAt, deliveredAt, sessionId: result.sessionId, manual, ok: true };
    } catch (error) {
      entry = { scheduledAt, deliveredAt, sessionId: reuse, manual, ok: false, error: error instanceof Error ? error.message : String(error) };
      log("scheduled task delivery failed", { taskId: task.id, error: entry.error });
    }
    task.lastDelivery = entry;
    task.history = pruneHistory([entry, ...task.history], now().toMillis());
    task.updatedAt = utc(now());
  }

  /** Deliver every due task once (latest-only catch-up) and commit its next occurrence. */
  async function tick(): Promise<void> {
    const due = (await load()).filter((task) => task.state === "active" && task.nextRunAt && Date.parse(task.nextRunAt) <= now().toMillis() && !executing.has(task.id));
    for (const task of due) {
      const reuse = task.target.kind === "session" ? task.target.session_id : task.target.kind === "new_once" ? task.reservedSessionId : null;
      // A reused chat keeps its slot until its current turn ends; the occurrence waits for the next tick.
      if (reuse && await input.port.isBusy(task.workspaceId, reuse).catch(() => false)) continue;
      const lastAt = task.lastDelivery ? Date.parse(task.lastDelivery.deliveredAt) : 0;
      if (now().toMillis() - lastAt < MIN_DELIVERY_SPACING_MS) continue;
      executing.add(task.id);
      try {
        const scheduledAt = task.nextRunAt ?? utc(now());
        await deliver(task, scheduledAt, false);
        const next = nextOccurrence(task.timing, now(), DateTime.fromISO(task.anchorAt, { zone: "UTC" }));
        task.nextRunAt = next ? utc(next) : null;
        if (!next) task.state = "ended";
        await save();
      } finally {
        executing.delete(task.id);
      }
    }
  }

  function schedule(): void {
    timer = setTimeout(() => {
      void serialize(tick).catch((error: unknown) => log("scheduled task tick failed", { error: String(error) })).finally(() => {
        if (timer) schedule();
      });
    }, TICK_MS);
    timer.unref?.();
  }

  return {
    start(): void {
      if (timer) return;
      schedule();
      void serialize(tick).catch(() => undefined);
    },
    stop(): void {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    list: (workspaceId: string, filter: { active?: boolean } = {}) => serialize(async () => {
      const items = (await load())
        .filter((task) => task.workspaceId === workspaceId && (filter.active === undefined || (task.state === "active") === filter.active))
        .sort((left, right) => Number(right.state === "active") - Number(left.state === "active") || left.createdAt.localeCompare(right.createdAt))
        .map(publicTask);
      return { items, total: items.length };
    }),
    view: (workspaceId: string, id: string) => serialize(async () => publicTask(await find(workspaceId, id))),
    create: (workspaceId: string, body: unknown) => serialize(async () => {
      const request = scheduleCreateSchema.parse(body);
      await checkTarget(workspaceId, request.target);
      const accepted = now();
      const task: StoredTask = {
        id: `sch_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
        workspaceId,
        title: request.title,
        prompt: request.prompt,
        timing: request.timing,
        target: request.target,
        model: request.model ?? null,
        state: "active",
        ...arm(request.timing, accepted),
        reservedSessionId: null,
        createdAt: utc(accepted),
        updatedAt: utc(accepted),
        lastDelivery: null,
        history: [],
      };
      (await load()).push(task);
      await save();
      return publicTask(task);
    }),
    update: (workspaceId: string, id: string, body: unknown) => serialize(async () => {
      const request = scheduleUpdateSchema.parse(body);
      const task = await find(workspaceId, id);
      if (request.expected_updated_at !== undefined && request.expected_updated_at !== task.updatedAt) {
        throw new ScheduleConflictError("This task changed since you read it. Reload it and try again.");
      }
      if (request.target) await checkTarget(workspaceId, request.target);
      const accepted = now();
      const timingChanged = request.timing !== undefined && JSON.stringify(request.timing) !== JSON.stringify(task.timing);
      if (request.title !== undefined) task.title = request.title;
      if (request.prompt !== undefined) task.prompt = request.prompt;
      if (request.model !== undefined) task.model = request.model;
      if (request.target) {
        task.target = request.target;
        if (request.target.kind !== "new_once") task.reservedSessionId = null;
      }
      if (request.timing) task.timing = request.timing;
      if (request.active === false) {
        task.state = "paused";
        task.nextRunAt = null;
      } else if (timingChanged || (request.active === true && task.state !== "active")) {
        // A changed rule or an explicit resume computes a new future occurrence; a
        // delivered one-shot needs new timing to resume.
        if (!timingChanged && (task.timing.kind === "after" || task.timing.kind === "at") && task.lastDelivery?.manual === false) {
          throw new ScheduleInputError("one_shot_delivered", "This one-time task already ran. Give it new timing to resume it.");
        }
        const anchor = timingChanged && task.timing.kind === "every" ? accepted : DateTime.fromISO(task.anchorAt, { zone: "UTC" });
        const first = timingChanged ? validateTiming(task.timing, accepted, accepted) : firstOccurrence(task.timing, accepted, anchor);
        if (!first) throw new ScheduleInputError("no_future_occurrence", "This timing has no future occurrence.");
        task.nextRunAt = utc(first);
        if (timingChanged) task.anchorAt = utc(accepted);
        task.state = "active";
      }
      // Revisions stay monotonic even if the clock moves backwards.
      const stamp = utc(accepted);
      task.updatedAt = stamp > task.updatedAt ? stamp : utc(DateTime.fromISO(task.updatedAt).plus({ milliseconds: 1 }));
      await save();
      return publicTask(task);
    }),
    remove: (workspaceId: string, id: string) => serialize(async () => {
      await find(workspaceId, id);
      const all = await load();
      tasks = all.filter((task) => task.id !== id);
      await save();
      return { deleted: true };
    }),
    deleteEnded: (workspaceId: string) => serialize(async () => {
      const all = await load();
      const kept = all.filter((task) => task.workspaceId !== workspaceId || task.state !== "ended");
      const deleted = all.length - kept.length;
      if (deleted > 0) {
        tasks = kept;
        await save();
      }
      return { deleted };
    }),
    /** Deliver now without moving the committed occurrence or the lifecycle. */
    run: (workspaceId: string, id: string) => serialize(async () => {
      const task = await find(workspaceId, id);
      const lastAt = task.lastDelivery ? Date.parse(task.lastDelivery.deliveredAt) : 0;
      if (now().toMillis() - lastAt < MIN_DELIVERY_SPACING_MS) {
        throw new ScheduleInputError("delivery_too_soon", "This task delivered less than a minute ago. Try again shortly.");
      }
      if (executing.has(task.id)) throw new ScheduleConflictError("This task is delivering right now.");
      executing.add(task.id);
      try {
        await deliver(task, utc(now()), true);
        await save();
      } finally {
        executing.delete(task.id);
      }
      return publicTask(task);
    }),
    /** For tests: run one evaluation pass synchronously. */
    tickNow: () => serialize(tick),
  };
}

export type ScheduleService = ReturnType<typeof createScheduleService>;
