/** Operation-sequence and recorded-time projections for the Trajectory overview. */
import type { TrajectoryCell, TrajectoryCellKind, TrajectoryTurn } from "./trajectory-model";

/** `sequence`: equal-width operations; `duration`: recorded durations with idle gaps removed. */
export type TrajectoryTimelineMode = "sequence" | "duration";

export type TrajectoryTimeRange = { start: number; end: number };

export type TrajectoryTimelineSpan = TrajectoryTimeRange & {
  index: number;
  isError: boolean;
  kind: TrajectoryCellKind;
  lane: number;
};

export type TrajectoryTimelineModel = TrajectoryTimeRange & {
  spans: TrajectoryTimelineSpan[];
  turnBoundaries: { turn: number; time: number }[];
};

function laneFor(kind: TrajectoryCellKind): number {
  if (kind === "tool") return 2;
  if (kind === "message" || kind === "compacted") return 1;
  return 0;
}

function cellsOf(turn: TrajectoryTurn): TrajectoryCell[] {
  return turn.groups.flatMap((group) => group.cells);
}

/**
 * Project every record into a stable three-lane (Input / Model / Tools) timeline.
 * @returns the model, or null when nothing is projectable.
 */
export function deriveTrajectoryTimeline(turns: readonly TrajectoryTurn[], mode: TrajectoryTimelineMode): TrajectoryTimelineModel | null {
  return mode === "sequence" ? sequenceTimeline(turns) : durationTimeline(turns);
}

function sequenceTimeline(turns: readonly TrajectoryTurn[]): TrajectoryTimelineModel | null {
  const spans: TrajectoryTimelineSpan[] = [];
  const turnBoundaries: { turn: number; time: number }[] = [];
  for (const turn of turns) {
    const cells = cellsOf(turn);
    if (cells.length === 0) continue;
    if (turn.turn !== null) turnBoundaries.push({ turn: turn.turn, time: spans.length });
    const offset = spans.length;
    spans.push(...cells.map((cell, position) => ({
      start: offset + position,
      end: offset + position + 1,
      index: cell.index,
      isError: cell.state === "error",
      kind: cell.kind,
      lane: laneFor(cell.kind),
    })));
  }
  return spans.length === 0 ? null : { start: 0, end: spans.length, spans, turnBoundaries };
}

function durationTimeline(turns: readonly TrajectoryTurn[]): TrajectoryTimelineModel | null {
  const timed = turns.flatMap((turn) => {
    const raw = cellsOf(turn).flatMap((cell): TrajectoryTimelineSpan[] => cell.startedAt === null ? [] : [{
      start: cell.startedAt,
      end: cell.startedAt + Math.max(0, cell.durationMs ?? 0),
      index: cell.index,
      isError: cell.state === "error",
      kind: cell.kind,
      lane: laneFor(cell.kind),
    }]);
    return raw.length === 0 ? [] : [{ turn: turn.turn, raw }];
  });
  const all = timed.flatMap((turn) => turn.raw);
  if (all.length === 0) return null;

  // Remove idle gaps where nothing ran, so long waits between turns do not
  // squeeze the operations into slivers.
  const removedBySpan = new Map<TrajectoryTimelineSpan, number>();
  let removed = 0;
  let coveredUntil: number | null = null;
  for (const span of [...all].sort((left, right) => left.start - right.start || left.end - right.end)) {
    if (coveredUntil !== null && span.start > coveredUntil) removed += span.start - coveredUntil;
    removedBySpan.set(span, removed);
    coveredUntil = coveredUntil === null ? span.end : Math.max(coveredUntil, span.end);
  }

  const spans: TrajectoryTimelineSpan[] = [];
  const turnBoundaries: { turn: number; time: number }[] = [];
  for (const turn of timed) {
    const projected = turn.raw.map((span) => {
      const offset = removedBySpan.get(span) ?? 0;
      return { ...span, start: span.start - offset, end: span.end - offset };
    });
    spans.push(...projected);
    if (turn.turn !== null) turnBoundaries.push({ turn: turn.turn, time: Math.min(...projected.map((span) => span.start)) });
  }
  return {
    start: Math.min(...spans.map((span) => span.start)),
    end: Math.max(...spans.map((span) => span.end)),
    spans,
    turnBoundaries,
  };
}

/** Record indexes active at any point inside an inclusive range. */
export function trajectoryTimelineFocusIndexes(model: TrajectoryTimelineModel | null, range: TrajectoryTimeRange): ReadonlySet<number> {
  return new Set(model?.spans.filter((span) => span.start <= range.end && span.end >= range.start).map((span) => span.index));
}
