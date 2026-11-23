import { describe, expect, test } from "bun:test";
import { DateTime } from "luxon";
import { firstOccurrence, nextOccurrence, parseCron, ScheduleInputError, validateTiming } from "./timing.js";

const at = (iso: string) => DateTime.fromISO(iso, { zone: "UTC" });
const iso = (value: DateTime | null) => value?.toUTC().toISO() ?? null;

describe("schedule timing", () => {
  test("after and at are one-shots", () => {
    const now = at("2026-12-01T10:00:00Z");
    expect(iso(firstOccurrence({ kind: "after", after_seconds: 90 }, now, now))).toBe("2026-12-01T10:01:30.000Z");
    expect(nextOccurrence({ kind: "after", after_seconds: 90 }, now, now)).toBeNull();
    expect(iso(firstOccurrence({ kind: "at", at: "2026-12-02T09:00:00+05:30" }, now, now))).toBe("2026-12-02T03:30:00.000Z");
    expect(iso(firstOccurrence({ kind: "at", at: { date: "2026-12-02", time: "09:00", time_zone: "Asia/Kolkata" } }, now, now))).toBe("2026-12-02T03:30:00.000Z");
    expect(() => validateTiming({ kind: "at", at: "2026-12-01T09:00:00Z" }, now, now)).toThrow(ScheduleInputError);
    expect(() => validateTiming({ kind: "at", at: "2026-12-02T09:00:00" }, now, now)).toThrow(/explicit Z/);
  });

  test("every stays aligned to its anchor and coalesces downtime", () => {
    const anchor = at("2026-12-01T10:00:00Z");
    const timing = { kind: "every" as const, every_seconds: 3600 };
    expect(iso(nextOccurrence(timing, at("2026-12-01T10:00:00Z"), anchor))).toBe("2026-12-01T11:00:00.000Z");
    // Twenty missed hours deliver once and land on the next aligned slot.
    expect(iso(nextOccurrence(timing, at("2026-12-02T06:17:00Z"), anchor))).toBe("2026-12-02T07:00:00.000Z");
  });

  test("daily and weekly use the wall clock of their zone", () => {
    const now = at("2026-12-01T05:00:00Z"); // 10:30 in Kolkata, Tuesday
    expect(iso(nextOccurrence({ kind: "daily", daily: { time: "09:00", time_zone: "Asia/Kolkata" } }, now, now))).toBe("2026-12-02T03:30:00.000Z");
    expect(iso(nextOccurrence({ kind: "daily", daily: { time: "11:00", time_zone: "Asia/Kolkata" } }, now, now))).toBe("2026-12-01T05:30:00.000Z");
    // Mon/Fri at 09:00 from a Tuesday morning: Friday.
    expect(iso(nextOccurrence({ kind: "weekly", weekly: { time: "09:00", time_zone: "Asia/Kolkata", weekdays: [1, 5] } }, now, now))).toBe("2026-12-04T03:30:00.000Z");
  });

  test("daily skips a wall time that a DST gap removes", () => {
    // 02:30 does not exist in New York on 2027-03-14.
    const now = at("2027-03-14T05:00:00Z");
    expect(iso(nextOccurrence({ kind: "daily", daily: { time: "02:30", time_zone: "America/New_York" } }, now, now))).toBe("2027-03-15T06:30:00.000Z");
  });

  test("cron follows Vixie day matching", () => {
    const now = at("2026-12-01T00:00:00Z"); // Tuesday
    const weekdays9 = { kind: "cron" as const, cron: { expression: "0 9 * * 1-5", time_zone: "UTC" } };
    expect(iso(nextOccurrence(weekdays9, now, now))).toBe("2026-12-01T09:00:00.000Z");
    // Both day fields restricted: the 15th OR any Sunday.
    const either = { kind: "cron" as const, cron: { expression: "30 8 15 * 0", time_zone: "UTC" } };
    expect(iso(nextOccurrence(either, now, now))).toBe("2026-12-06T08:30:00.000Z");
    expect(iso(nextOccurrence(either, at("2026-12-13T09:00:00Z"), now))).toBe("2026-12-15T08:30:00.000Z");
    // Sunday as 7 is the same as 0; steps work.
    expect([...parseCron("*/15 * * * 7").dayOfWeek.values]).toEqual([0]);
    expect([...parseCron("*/15 * * * *").minute.values]).toEqual([0, 15, 30, 45]);
  });

  test("cron rejects unsupported syntax", () => {
    for (const expression of ["0 9 * *", "0 9 * * MON", "5/10 * * * *", "61 * * * *", "@daily"]) {
      expect(() => parseCron(expression)).toThrow(ScheduleInputError);
    }
  });

  test("rrule honours UTC and TZID starts", () => {
    const now = at("2026-12-01T10:00:00Z");
    const utc = { kind: "rrule" as const, rrule: "DTSTART:20261201T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE" };
    expect(iso(nextOccurrence(utc, now, now))).toBe("2026-12-02T09:00:00.000Z");
    // 09:00 in Kolkata is 03:30 UTC; the floating rrule result must be converted.
    const local = { kind: "rrule" as const, rrule: "DTSTART;TZID=Asia/Kolkata:20261201T090000\nRRULE:FREQ=DAILY" };
    expect(iso(nextOccurrence(local, now, now))).toBe("2026-12-02T03:30:00.000Z");
    const ended = { kind: "rrule" as const, rrule: "DTSTART:20261101T090000Z\nRRULE:FREQ=DAILY;COUNT=2" };
    expect(nextOccurrence(ended, now, now)).toBeNull();
    expect(() => validateTiming(ended, now, now)).toThrow(/no future occurrence/);
    expect(() => validateTiming({ kind: "rrule", rrule: "RRULE:FREQ=DAILY" }, now, now)).toThrow(ScheduleInputError);
  });

  test("unknown zones are rejected", () => {
    const now = at("2026-12-01T10:00:00Z");
    expect(() => validateTiming({ kind: "daily", daily: { time: "09:00", time_zone: "Mars/Olympus" } }, now, now)).toThrow(/time zone/);
  });
});
