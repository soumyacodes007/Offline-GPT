/**
 * Local product events for the OfflineGPT app.
 *
 * Nothing here leaves the device: events are only recorded in the local app
 * inspector (`window.__offlinegpt.record("analytics.<event>")`) so coded evals
 * can assert instrumentation. There is no analytics backend.
 */
import { recordInspectorEvent } from "./app-inspector";

export type AnalyticsProperties = Record<string, string | number | boolean | null>;

export function captureAnalyticsEvent(event: string, properties: AnalyticsProperties = {}) {
  try {
    recordInspectorEvent(`analytics.${event}`, properties);
  } catch {
    // Inspector unavailable (non-browser context).
  }
}

// Task run duration tracking: sendDraft marks the start, the session.idle
// sync event takes it. Also acts as a dedupe guard so idle events that do
// not correspond to an instrumented run (or arrive from a second workspace
// sync) emit nothing.
const taskRunStarts = new Map<string, number>();

export function markTaskRunStart(sessionId: string) {
  if (sessionId.trim()) taskRunStarts.set(sessionId, Date.now());
}

export function takeTaskRunStart(sessionId: string): number | null {
  const startedAt = taskRunStarts.get(sessionId);
  if (startedAt === undefined) return null;
  taskRunStarts.delete(sessionId);
  return startedAt;
}
