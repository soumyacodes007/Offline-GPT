import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "luxon";
import type { ServerConfig } from "../types.js";
import { createScheduleService, ScheduleConflictError, type ScheduleDeliveryRequest } from "./service.js";
import { ScheduleInputError } from "./timing.js";

let root = "";
let clock = DateTime.fromISO("2026-12-01T09:00:00Z", { zone: "UTC" });
const config = () => ({ configPath: join(root, "server.json") }) as unknown as ServerConfig;

function fakePort() {
  const deliveries: ScheduleDeliveryRequest[] = [];
  const sessions = new Set<string>(["ses_existing"]);
  const busy = new Set<string>();
  let created = 0;
  return {
    deliveries,
    sessions,
    busy,
    port: {
      async deliver(request: ScheduleDeliveryRequest) {
        deliveries.push(request);
        const sessionId = request.sessionId ?? `ses_new_${++created}`;
        sessions.add(sessionId);
        return { sessionId };
      },
      async isBusy(_workspace: string, sessionId: string) { return busy.has(sessionId); },
      async sessionExists(_workspace: string, sessionId: string) { return sessions.has(sessionId); },
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "offlinegpt-schedule-"));
  clock = DateTime.fromISO("2026-12-01T09:00:00Z", { zone: "UTC" });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("schedule service", () => {
  test("creates, delivers once when due, and reuses the new_once chat", async () => {
    const fake = fakePort();
    const service = createScheduleService({ config: config(), port: fake.port, now: () => clock });
    const task = await service.create("ws_1", { title: "Standup", prompt: "Summarize yesterday", timing: { kind: "every", every_seconds: 3600 } });
    expect(task).toMatchObject({ state: "active", nextRunAt: "2026-12-01T10:00:00.000Z", target: { kind: "new_once" } });

    await service.tickNow();
    expect(fake.deliveries).toHaveLength(0);

    clock = clock.plus({ hours: 1 });
    await service.tickNow();
    expect(fake.deliveries.map((entry) => entry.sessionId)).toEqual([null]);
    const afterFirst = await service.view("ws_1", task.id);
    expect(afterFirst).toMatchObject({ reservedSessionId: "ses_new_1", nextRunAt: "2026-12-01T11:00:00.000Z" });
    expect(afterFirst.history[0]).toMatchObject({ ok: true, sessionId: "ses_new_1", manual: false });

    // Five hours of downtime deliver once (latest-only catch-up) into the same chat.
    clock = clock.plus({ hours: 5, minutes: 10 });
    await service.tickNow();
    expect(fake.deliveries.map((entry) => entry.sessionId)).toEqual([null, "ses_new_1"]);
    expect((await service.view("ws_1", task.id)).nextRunAt).toBe("2026-12-01T16:00:00.000Z");
  });

  test("a busy reused chat defers delivery until its turn ends", async () => {
    const fake = fakePort();
    const service = createScheduleService({ config: config(), port: fake.port, now: () => clock });
    await service.create("ws_1", { title: "Ping", prompt: "Ping", timing: { kind: "after", after_seconds: 60 }, target: { kind: "session", session_id: "ses_existing" } });
    fake.busy.add("ses_existing");
    clock = clock.plus({ minutes: 2 });
    await service.tickNow();
    expect(fake.deliveries).toHaveLength(0);
    fake.busy.delete("ses_existing");
    await service.tickNow();
    expect(fake.deliveries.map((entry) => entry.sessionId)).toEqual(["ses_existing"]);
    // The one-shot ends after delivering.
    expect((await service.list("ws_1")).items[0]).toMatchObject({ state: "ended", nextRunAt: null });
  });

  test("validates input, targets, and optimistic revisions", async () => {
    const fake = fakePort();
    const service = createScheduleService({ config: config(), port: fake.port, now: () => clock });
    await expect(service.create("ws_1", { title: "x", prompt: "x", timing: { kind: "cron", cron: { expression: "0 9 * *", time_zone: "UTC" } } })).rejects.toThrow(ScheduleInputError);
    await expect(service.create("ws_1", { title: "x", prompt: "x", timing: { kind: "daily", daily: { time: "09:00", time_zone: "UTC" } }, target: { kind: "session", session_id: "ses_missing" } })).rejects.toThrow(/does not exist/);
    const task = await service.create("ws_1", { title: "x", prompt: "x", timing: { kind: "daily", daily: { time: "09:30", time_zone: "UTC" } } });
    await expect(service.update("ws_1", task.id, { title: "y", expected_updated_at: "stale" })).rejects.toThrow(ScheduleConflictError);
    await expect(service.view("ws_2", task.id)).rejects.toThrow(/not found/);
  });

  test("pause, resume, run now, and history", async () => {
    const fake = fakePort();
    const service = createScheduleService({ config: config(), port: fake.port, now: () => clock });
    const task = await service.create("ws_1", { title: "Daily", prompt: "Daily", timing: { kind: "daily", daily: { time: "10:00", time_zone: "UTC" } } });
    const paused = await service.update("ws_1", task.id, { active: false });
    expect(paused).toMatchObject({ state: "paused", nextRunAt: null });
    clock = clock.plus({ hours: 2 });
    await service.tickNow();
    expect(fake.deliveries).toHaveLength(0);

    const resumed = await service.update("ws_1", task.id, { active: true });
    expect(resumed).toMatchObject({ state: "active", nextRunAt: "2026-12-02T10:00:00.000Z" });

    // Run now delivers without moving the committed occurrence, and is rate limited.
    const ran = await service.run("ws_1", task.id);
    expect(ran.nextRunAt).toBe("2026-12-02T10:00:00.000Z");
    expect(ran.history[0]).toMatchObject({ manual: true, ok: true });
    await expect(service.run("ws_1", task.id)).rejects.toThrow(/less than a minute/);
  });

  test("persists across restarts and keeps failures in history", async () => {
    const fake = fakePort();
    const first = createScheduleService({ config: config(), port: { ...fake.port, deliver: async () => { throw new Error("engine down"); } }, now: () => clock });
    const task = await first.create("ws_1", { title: "x", prompt: "x", timing: { kind: "after", after_seconds: 30 } });
    clock = clock.plus({ minutes: 1 });
    await first.tickNow();

    const second = createScheduleService({ config: config(), port: fake.port, now: () => clock });
    const reloaded = await second.view("ws_1", task.id);
    expect(reloaded.lastDelivery).toMatchObject({ ok: false, error: "engine down" });
    expect(reloaded.state).toBe("ended");
    const stored = JSON.parse(await readFile(join(root, "schedule.json"), "utf8"));
    expect(stored.version).toBe(1);
    expect((await second.deleteEnded("ws_1")).deleted).toBe(1);
    expect((await second.list("ws_1")).total).toBe(0);
  });
});
