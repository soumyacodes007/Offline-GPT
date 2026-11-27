import { DateTime, IANAZone } from "luxon";
import { createRequire } from "node:module";
import type { ScheduleTiming } from "@offlinegpt/types/schedule";

// rrule ships CommonJS for Node and an ES module for bundlers, with different
// default exports. Loading it through require gives the same module in Node,
// Electron and the compiled server binary.
const rruleModule: typeof import("rrule") = createRequire(import.meta.url)("rrule");
const { rrulestr } = rruleModule;

/** A rejected timing, reported to agents and the UI as an input error. */
export class ScheduleInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** Cron and RRULE searches stop after this many years without a match. */
const SEARCH_YEARS = 8;

function zoneOf(name: string): string {
  if (!IANAZone.isValidZone(name)) throw new ScheduleInputError("invalid_time_zone", `Unknown IANA time zone "${name}".`);
  return name;
}

function parseLocalTime(value: string): { hour: number; minute: number; second: number } {
  const [hour = 0, minute = 0, second = 0] = value.split(":").map(Number);
  return { hour, minute, second };
}

/** Build a local wall time, or null when the zone skips it (a DST gap). */
function localInstant(zone: string, date: { year: number; month: number; day: number }, time: { hour: number; minute: number; second?: number }): DateTime | null {
  const value = DateTime.fromObject({ ...date, ...time, millisecond: 0 }, { zone });
  return value.isValid && value.hour === time.hour && value.minute === time.minute ? value : null;
}

// ---------------------------------------------------------------------------
// Cron: five numeric fields, Vixie day matching.

type CronField = { values: Set<number>; star: boolean };
type ParsedCron = { minute: CronField; hour: CronField; dayOfMonth: CronField; month: CronField; dayOfWeek: CronField };

function parseCronField(raw: string, min: number, max: number, name: string): CronField {
  const values = new Set<number>();
  for (const atom of raw.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(atom);
    if (!match) throw new ScheduleInputError("invalid_cron", `Cron ${name} field "${raw}" is not supported. Use *, a number, a range, a step, or a comma list.`);
    const [, whole, start, end, step] = match;
    // A value followed by a step ("5/10") is ambiguous across cron dialects; Vixie rejects it too.
    if (step && whole !== "*" && end === undefined) throw new ScheduleInputError("invalid_cron", `Cron ${name} field "${atom}" needs a range or * before the step.`);
    const low = whole === "*" ? min : Number(start);
    const high = whole === "*" ? max : end === undefined ? low : Number(end);
    const stride = step ? Number(step) : 1;
    if (low < min || high > max || low > high || stride < 1) throw new ScheduleInputError("invalid_cron", `Cron ${name} field "${atom}" is outside ${min}-${max}.`);
    for (let value = low; value <= high; value += stride) values.add(value);
  }
  return { values, star: raw.startsWith("*") };
}

export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new ScheduleInputError("invalid_cron", "Cron needs exactly five fields: minute hour day-of-month month day-of-week.");
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const dow = parseCronField(dayOfWeek, 0, 7, "day-of-week");
  // Sunday is 0 or 7; canonicalize to 0.
  if (dow.values.delete(7)) dow.values.add(0);
  return {
    minute: parseCronField(minute, 0, 59, "minute"),
    hour: parseCronField(hour, 0, 23, "hour"),
    dayOfMonth: parseCronField(dayOfMonth, 1, 31, "day-of-month"),
    month: parseCronField(month, 1, 12, "month"),
    dayOfWeek: dow,
  };
}

function cronDayMatches(cron: ParsedCron, day: DateTime): boolean {
  if (!cron.month.values.has(day.month)) return false;
  const dom = cron.dayOfMonth.values.has(day.day);
  const dow = cron.dayOfWeek.values.has(day.weekday % 7);
  // Vixie: when both day fields are restricted, either may match.
  if (!cron.dayOfMonth.star && !cron.dayOfWeek.star) return dom || dow;
  return dom && dow;
}

function nextCron(cron: ParsedCron, zone: string, after: DateTime): DateTime | null {
  const hours = [...cron.hour.values].sort((a, b) => a - b);
  const minutes = [...cron.minute.values].sort((a, b) => a - b);
  let day = after.setZone(zone).startOf("day");
  for (let index = 0; index < SEARCH_YEARS * 366; index += 1, day = day.plus({ days: 1 })) {
    if (!cronDayMatches(cron, day)) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = localInstant(zone, { year: day.year, month: day.month, day: day.day }, { hour, minute });
        if (candidate && candidate > after) return candidate;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// RRULE: a DTSTART line and an RRULE line (RFC 5545 subset via rrule 2.8.1).

function parseRrule(text: string) {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 2 || !lines[0].startsWith("DTSTART") || !lines[1].startsWith("RRULE:")) {
    throw new ScheduleInputError("invalid_rrule", "RRULE timing needs exactly two lines: DTSTART (UTC Z or ;TZID=Zone) then RRULE:...");
  }
  if (/FREQ=SECONDLY/.test(lines[1])) throw new ScheduleInputError("invalid_rrule", "SECONDLY recurrence is not supported.");
  const tzid = /^DTSTART;TZID=([^:]+):/.exec(lines[0])?.[1];
  if (!tzid && !/^DTSTART:\d{8}T\d{6}Z$/.test(lines[0])) {
    throw new ScheduleInputError("invalid_rrule", "DTSTART must be UTC (ending in Z) or carry an explicit ;TZID=.");
  }
  const zone = tzid ? zoneOf(tzid) : "UTC";
  // rrule's own TZID handling depends on the host time zone, so evaluate the
  // local wall times as UTC ("floating") and convert with luxon instead.
  const start = tzid ? lines[0].replace(/^DTSTART;TZID=[^:]+:(\d{8}T\d{6})$/, "DTSTART:$1Z") : lines[0];
  if (tzid && !/^DTSTART:\d{8}T\d{6}Z$/.test(start)) {
    throw new ScheduleInputError("invalid_rrule", "DTSTART;TZID= needs a YYYYMMDDTHHMMSS local date-time.");
  }
  try {
    return { rule: rrulestr(`${start}\n${lines[1]}`), zone, floating: Boolean(tzid) };
  } catch (error) {
    throw new ScheduleInputError("invalid_rrule", `RRULE could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Floating dates carry the zone's local wall time in their UTC fields. */
function toFloating(value: DateTime, zone: string): Date {
  const local = value.setZone(zone);
  return new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second));
}

function fromFloating(value: Date, zone: string): DateTime {
  return DateTime.fromObject({
    year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate(),
    hour: value.getUTCHours(), minute: value.getUTCMinutes(), second: value.getUTCSeconds(),
  }, { zone });
}

function nextRrule(text: string, after: DateTime): DateTime | null {
  const { rule, zone, floating } = parseRrule(text);
  const next = rule.after(floating ? toFloating(after, zone) : after.toJSDate(), false);
  if (!next) return null;
  return floating ? fromFloating(next, zone) : DateTime.fromJSDate(next, { zone: "UTC" });
}

// ---------------------------------------------------------------------------

function parseAt(at: Extract<ScheduleTiming, { kind: "at" }>["at"]): DateTime {
  if (typeof at === "string") {
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(at)) throw new ScheduleInputError("invalid_at", "An absolute time needs an explicit Z or numeric offset, or { date, time, time_zone }.");
    const value = DateTime.fromISO(at, { setZone: true });
    if (!value.isValid) throw new ScheduleInputError("invalid_at", `"${at}" is not an RFC 3339 instant.`);
    return value;
  }
  const [year, month, day] = at.date.split("-").map(Number);
  const value = localInstant(zoneOf(at.time_zone), { year, month, day }, parseLocalTime(at.time));
  if (!value) throw new ScheduleInputError("invalid_at", `${at.date} ${at.time} does not exist in ${at.time_zone} (daylight-saving gap).`);
  return value;
}

function nextWallClock(zone: string, time: string, after: DateTime, weekdays?: number[]): DateTime | null {
  const clock = parseLocalTime(time);
  let day = after.setZone(zone).startOf("day");
  for (let index = 0; index < 15; index += 1, day = day.plus({ days: 1 })) {
    if (weekdays && !weekdays.includes(day.weekday)) continue;
    const candidate = localInstant(zone, { year: day.year, month: day.month, day: day.day }, clock);
    if (candidate && candidate > after) return candidate;
  }
  return null;
}

/**
 * Check a timing before it is saved: zones exist, expressions parse, and a
 * new rule has a future occurrence. Throws ScheduleInputError.
 */
export function validateTiming(timing: ScheduleTiming, now: DateTime, anchor: DateTime): DateTime {
  if (timing.kind === "daily") zoneOf(timing.daily.time_zone);
  if (timing.kind === "weekly") {
    zoneOf(timing.weekly.time_zone);
    if (new Set(timing.weekly.weekdays).size !== timing.weekly.weekdays.length) throw new ScheduleInputError("invalid_weekdays", "Weekdays must be unique.");
  }
  if (timing.kind === "cron") {
    zoneOf(timing.cron.time_zone);
    parseCron(timing.cron.expression);
  }
  const first = firstOccurrence(timing, now, anchor);
  if (!first) throw new ScheduleInputError("no_future_occurrence", "This timing has no future occurrence.");
  return first;
}

/** The first occurrence strictly after `now` for a newly armed rule. */
export function firstOccurrence(timing: ScheduleTiming, now: DateTime, anchor: DateTime): DateTime | null {
  if (timing.kind === "after") return anchor.plus({ seconds: timing.after_seconds });
  if (timing.kind === "at") {
    const at = parseAt(timing.at);
    return at > now ? at : null;
  }
  return nextOccurrence(timing, now, anchor);
}

/**
 * The next occurrence strictly after `after`. One-shots (`after`, `at`) have
 * none once delivered; `every` stays aligned to its anchor.
 */
export function nextOccurrence(timing: ScheduleTiming, after: DateTime, anchor: DateTime): DateTime | null {
  switch (timing.kind) {
    case "after":
    case "at":
      return null;
    case "every": {
      const elapsed = after.toMillis() - anchor.toMillis();
      const periods = Math.floor(elapsed / (timing.every_seconds * 1000)) + 1;
      return anchor.plus({ milliseconds: Math.max(1, periods) * timing.every_seconds * 1000 });
    }
    case "daily":
      return nextWallClock(zoneOf(timing.daily.time_zone), timing.daily.time, after);
    case "weekly":
      return nextWallClock(zoneOf(timing.weekly.time_zone), timing.weekly.time, after, timing.weekly.weekdays);
    case "cron":
      return nextCron(parseCron(timing.cron.expression), zoneOf(timing.cron.time_zone), after);
    case "rrule":
      return nextRrule(timing.rrule, after);
  }
}

/** A short human description for lists and tool results. */
export function describeTiming(timing: ScheduleTiming): string {
  switch (timing.kind) {
    case "after":
      return `once, ${timing.after_seconds} s after creation`;
    case "at":
      return typeof timing.at === "string" ? `once at ${timing.at}` : `once at ${timing.at.date} ${timing.at.time} (${timing.at.time_zone})`;
    case "every":
      return `every ${timing.every_seconds} s`;
    case "daily":
      return `daily at ${timing.daily.time} (${timing.daily.time_zone})`;
    case "weekly":
      return `weekly on ${timing.weekly.weekdays.map((day) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day - 1]).join(", ")} at ${timing.weekly.time} (${timing.weekly.time_zone})`;
    case "cron":
      return `cron "${timing.cron.expression}" (${timing.cron.time_zone})`;
    case "rrule":
      return `rrule ${timing.rrule.replace(/\s+/g, " ")}`;
  }
}
