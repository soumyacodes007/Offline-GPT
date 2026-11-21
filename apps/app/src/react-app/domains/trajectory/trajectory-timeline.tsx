/** Chrome-Network-style overview above the ledger (ported from DeepSeek Harness). */
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";

import { formatClock, formatDurationMs, trajectoryCopy } from "./trajectory-copy";
import type { TrajectoryCell, TrajectoryCellKind } from "./trajectory-model";
import type { TrajectoryTimeRange, TrajectoryTimelineMode, TrajectoryTimelineModel } from "./trajectory-timeline-model";

const MINIMUM_DRAG_PX = 3;
const MINIMUM_ZOOM_OPERATIONS = 4;
const EDGE_PAN_ZONE_FRACTION = 0.08;
const EDGE_PAN_STEP_FRACTION = 0.025;
const MAXIMUM_EDGE_PAN_PX = 32;
const TOOLTIP_DELAY_MS = 500;

const SPAN_COLOR: Record<TrajectoryCellKind, string> = {
  system: "bg-dls-secondary opacity-[0.78]",
  user: "bg-blue-9 opacity-[0.78]",
  context: "bg-green-10 opacity-[0.78]",
  compacted: "bg-violet-10",
  message: "bg-violet-10",
  tool: "bg-amber-9",
};

const KIND_HEADING: Record<TrajectoryCellKind, string> = trajectoryCopy.kind;

type FractionRange = { start: number; end: number };
type HoverPoint = { fraction: number; recordIndex: number | null; x: number };
type PanGesture = { anchorClientX: number; anchorStart: number; moved: boolean; pannable: boolean; pointerId: number };

function clampFraction(value: number) {
  return Math.min(1, Math.max(0, value));
}

function orderedRange(left: number, right: number): FractionRange {
  return left <= right ? { start: left, end: right } : { start: right, end: left };
}

function centeredRange(center: number, width: number, minimum: number, maximum: number): FractionRange {
  const clamped = Math.min(maximum - minimum, Math.max(0, width));
  const start = Math.min(Math.max(center - clamped / 2, minimum), maximum - clamped);
  return { start, end: start + clamped };
}

function rangeFraction(range: TrajectoryTimeRange, start: number, duration: number, minimum: number, maximum: number): FractionRange {
  const bounded = orderedRange(Math.min(maximum, Math.max(minimum, range.start)), Math.min(maximum, Math.max(minimum, range.end)));
  return { start: (bounded.start - start) / duration, end: (bounded.end - start) / duration };
}

function ttftFraction(cell: TrajectoryCell | undefined): number | null {
  if (cell?.kind !== "message" || cell.startedAt === null || cell.firstTokenAt == null || cell.completedAt == null) return null;
  const total = cell.completedAt - cell.startedAt;
  return total > 0 && cell.firstTokenAt >= cell.startedAt ? (cell.firstTokenAt - cell.startedAt) / total : null;
}

function tooltipText(cell: TrajectoryCell | undefined): string {
  if (!cell) return "";
  const lines: string[] = [KIND_HEADING[cell.kind]];
  if (cell.startedAt !== null) {
    lines.push(cell.durationMs === null
      ? `Started ${formatClock(cell.startedAt)}`
      : `${formatClock(cell.startedAt)} → ${formatClock(cell.startedAt + cell.durationMs)}`);
  }
  const timing: string[] = [];
  if (cell.durationMs !== null) timing.push(`Total ${formatDurationMs(cell.durationMs)}`);
  if (cell.kind === "message" && cell.startedAt !== null && cell.firstTokenAt != null && cell.completedAt != null) {
    timing.push(`TTFT ${formatDurationMs(cell.firstTokenAt - cell.startedAt)} · Decoding ${formatDurationMs(cell.completedAt - cell.firstTokenAt)}`);
  }
  if (timing.length) lines.push(timing.join(" · "));
  return lines.join("\n");
}

export type TrajectoryTimelineProps = {
  model: TrajectoryTimelineModel | null;
  mode: TrajectoryTimelineMode;
  cellsByIndex: ReadonlyMap<number, TrajectoryCell>;
  range: TrajectoryTimeRange | null;
  selectedIndex: number | null;
  searchMatchIndexes: ReadonlySet<number> | null;
  hasEarlierRecords: boolean;
  onLoadEarlier?: () => Promise<boolean>;
  onRangeChange: (range: TrajectoryTimeRange | null) => void;
  onRecordSelect: (index: number) => void;
  onRecordFocus: (index: number) => void;
};

function LaneLabels() {
  return (
    <div className="relative border-r-[0.5px] border-gray-a4 text-[10px] leading-none text-gray-9" aria-hidden="true">
      <span className="absolute right-[3px] top-[7px] flex h-2 items-center">{trajectoryCopy.lane.input}</span>
      <span className="absolute right-[3px] top-[21px] flex h-2 items-center">{trajectoryCopy.lane.model}</span>
      <span className="absolute right-[3px] top-[35px] flex h-2 items-center">{trajectoryCopy.lane.tools}</span>
    </div>
  );
}

function EarlierHistoryBoundary(props: { loading: boolean; onLoad?: () => void }) {
  return (
    <button
      type="button"
      data-earlier-history=""
      title={props.loading ? trajectoryCopy.history.loadingEarlier : trajectoryCopy.history.clickToLoadEarlier}
      aria-label={props.loading ? trajectoryCopy.history.loadingEarlier : trajectoryCopy.history.loadEarlier}
      aria-disabled={props.loading || !props.onLoad}
      onClick={props.onLoad}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      className="absolute inset-y-0 left-0 z-[5] box-border flex w-7 cursor-pointer appearance-none items-center justify-start border-0 bg-[linear-gradient(to_right,var(--color-dls-surface-muted)_0,var(--color-dls-surface-muted)_38%,transparent_100%)] pl-[3px] text-[13px] leading-none text-dls-secondary opacity-[0.72] outline-none hover:opacity-100 aria-disabled:cursor-default"
    >
      …
    </button>
  );
}

/** Overview renderer with drag ranges, wheel zoom, right-drag pan, and Escape reset. */
export const TrajectoryTimeline = memo(function TrajectoryTimeline(props: TrajectoryTimelineProps) {
  const { model, mode, range, selectedIndex, searchMatchIndexes, onRangeChange } = props;
  const dragRef = useRef<{ pointerId: number; anchorTime: number; anchorClientX: number; recordIndex: number | null } | null>(null);
  const panRef = useRef<PanGesture | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<TrajectoryTimeRange | null>(null);
  const [hover, setHover] = useState<HoverPoint | null>(null);
  const [tooltipIndex, setTooltipIndex] = useState<number | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [panning, setPanning] = useState(false);
  const [viewport, setViewport] = useState<TrajectoryTimeRange | null>(null);
  const [animateViewport, setAnimateViewport] = useState(false);

  useEffect(() => {
    if (model && range && (range.end < model.start || range.start > model.end)) onRangeChange(null);
  }, [model, onRangeChange, range]);
  useEffect(() => {
    if (!model) return;
    setAnimateViewport(false);
    setViewport((current) => current && (current.end < model.start || current.start > model.end) ? null : current);
  }, [model]);
  useEffect(() => {
    if (!model || selectedIndex === null) return;
    const selected = model.spans.find((span) => span.index === selectedIndex);
    if (!selected) return;
    setAnimateViewport(true);
    setViewport((current) => {
      if (!current || (selected.end > current.start && selected.start < current.end)) return current;
      const duration = Math.max(1, current.end - current.start);
      const desired = selected.end <= current.start ? selected.start : selected.end - duration;
      const next = Math.min(Math.max(desired, model.start), Math.max(model.start, model.end - duration));
      return next === current.start ? current : { start: next, end: next + duration };
    });
  }, [model, selectedIndex]);

  const hoveredIndex = hover?.recordIndex ?? null;
  useEffect(() => {
    setTooltipIndex(null);
    if (hoveredIndex === null || draft !== null) return;
    const timer = window.setTimeout(() => setTooltipIndex(hoveredIndex), TOOLTIP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [draft, hoveredIndex]);

  const fullDuration = Math.max(1, (model?.end ?? 0) - (model?.start ?? 0));
  const viewportDuration = Math.min(fullDuration, Math.max(1, (viewport?.end ?? 0) - (viewport?.start ?? 0)));
  const viewportStart = !model || !viewport
    ? model?.start ?? 0
    : Math.min(Math.max(viewport.start, model.start), model.end - viewportDuration);
  const domainDuration = viewport === null ? fullDuration : viewportDuration;
  const domainStart = viewport === null ? model?.start ?? 0 : viewportStart;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const track = trackRef.current;
      if (!track || !model) return;
      setAnimateViewport(false);
      const rect = track.getBoundingClientRect();
      const anchor = clampFraction((event.clientX - rect.left) / Math.max(1, rect.width));
      const nextDuration = Math.min(
        fullDuration,
        Math.max(Math.min(mode === "sequence" ? MINIMUM_ZOOM_OPERATIONS : 20, fullDuration), domainDuration * Math.exp(event.deltaY * 0.0015)),
      );
      if (nextDuration >= fullDuration * 0.999) {
        setViewport(null);
        return;
      }
      const anchorTime = domainStart + anchor * domainDuration;
      const nextStart = Math.min(Math.max(anchorTime - anchor * nextDuration, model.start), model.end - nextDuration);
      setViewport({ start: nextStart, end: nextStart + nextDuration });
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [domainDuration, domainStart, fullDuration, mode, model]);

  const loadEarlier = !props.onLoadEarlier || loadingEarlier
    ? undefined
    : () => {
      setLoadingEarlier(true);
      void props.onLoadEarlier?.().finally(() => setLoadingEarlier(false));
    };

  const rootClass = "relative isolate z-[1] flex-none select-none border-b-[0.5px] border-dls-border";
  const plotClass = "grid h-[50px] grid-cols-[44px_minmax(0,1fr)] overflow-hidden bg-dls-surface-muted";

  if (!model) {
    return (
      <section ref={rootRef} className={rootClass} aria-label={trajectoryCopy.timeline.aria}>
        <div className={plotClass}>
          <LaneLabels />
          <div className="relative overflow-hidden">
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[13px] text-gray-9">{trajectoryCopy.timeline.noTimingData}</span>
            {props.hasEarlierRecords ? <EarlierHistoryBoundary loading={loadingEarlier} onLoad={loadEarlier} /> : null}
          </div>
        </div>
      </section>
    );
  }

  const committed = range === null ? null : rangeFraction(range, domainStart, domainDuration, model.start, model.end);
  const draftFraction = draft === null ? null : rangeFraction(draft, domainStart, domainDuration, model.start, model.end);
  const visibleRange = draftFraction ?? committed;
  const activeRange = draft ?? range;
  const minimumSelection = Math.min(domainDuration, fullDuration / model.spans.length);
  const domainStyle: CSSProperties = {
    left: `${-(domainStart - model.start) / domainDuration * 100}%`,
    width: `${fullDuration / domainDuration * 100}%`,
  };

  const fractionAt = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return clampFraction((event.clientX - rect.left) / Math.max(1, rect.width));
  };
  const recordIndexAt = (event: PointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const value = target?.closest<HTMLElement>("[data-timeline-record-index]")?.dataset.timelineRecordIndex;
    if (value === undefined) return null;
    const index = Number(value);
    return Number.isFinite(index) ? index : null;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button === 2) {
      panRef.current = { anchorClientX: event.clientX, anchorStart: domainStart, moved: false, pannable: viewport !== null, pointerId: event.pointerId };
      if (viewport !== null) setAnimateViewport(false);
      setPanning(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    const anchor = fractionAt(event);
    const anchorTime = domainStart + anchor * domainDuration;
    const recordIndex = recordIndexAt(event);
    setHover({ fraction: anchor, recordIndex, x: event.clientX - event.currentTarget.getBoundingClientRect().left });
    dragRef.current = { pointerId: event.pointerId, anchorTime, anchorClientX: event.clientX, recordIndex };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDraft({ start: anchorTime, end: anchorTime });
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = fractionAt(event);
    setHover({ fraction, recordIndex: recordIndexAt(event), x: event.clientX - rect.left });
    const pan = panRef.current;
    if (pan && pan.pointerId === event.pointerId) {
      if (Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX) pan.moved = true;
      if (!pan.pannable) return;
      const delta = (event.clientX - pan.anchorClientX) / Math.max(1, rect.width);
      const nextStart = Math.min(Math.max(pan.anchorStart - delta * domainDuration, model.start), model.end - domainDuration);
      setViewport({ start: nextStart, end: nextStart + domainDuration });
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    let nextDomainStart = domainStart;
    if (viewport !== null) {
      // Dragging near an edge of a zoomed overview pans it along.
      const localX = event.clientX - rect.left;
      const edge = Math.min(MAXIMUM_EDGE_PAN_PX, Math.max(1, rect.width * EDGE_PAN_ZONE_FRACTION));
      const direction = localX < edge ? -1 : localX > rect.width - edge ? 1 : 0;
      if (direction !== 0) {
        const distance = direction < 0 ? edge - localX : localX - (rect.width - edge);
        const strength = clampFraction(distance / edge);
        const desired = domainStart + direction * domainDuration * EDGE_PAN_STEP_FRACTION * Math.max(0.2, strength);
        nextDomainStart = Math.min(Math.max(desired, model.start), model.end - domainDuration);
        if (nextDomainStart !== domainStart) {
          setAnimateViewport(false);
          setViewport({ start: nextDomainStart, end: nextDomainStart + domainDuration });
        }
      }
    }
    setDraft(orderedRange(drag.anchorTime, nextDomainStart + fraction * domainDuration));
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan && pan.pointerId === event.pointerId) {
      const moved = pan.moved || Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX;
      panRef.current = null;
      setPanning(false);
      if (!moved) onRangeChange(null);
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = domainStart + fractionAt(event) * domainDuration;
    const selected = orderedRange(drag.anchorTime, point);
    dragRef.current = null;
    setDraft(null);
    const click = Math.abs(event.clientX - drag.anchorClientX) < MINIMUM_DRAG_PX;
    const clickedSpan = click && drag.recordIndex !== null ? model.spans.find((span) => span.index === drag.recordIndex) : undefined;
    if (clickedSpan) {
      onRangeChange(null);
      props.onRecordSelect(clickedSpan.index);
      return;
    }
    onRangeChange(selected.end - selected.start < minimumSelection
      ? centeredRange(click ? selected.start : (selected.start + selected.end) / 2, minimumSelection, model.start, model.end)
      : selected);
    if (click) {
      const at = selected.start;
      const distance = (span: TrajectoryTimeRange) => at < span.start ? span.start - at : at > span.end ? at - span.end : 0;
      const nearest = model.spans.reduce((best, span) => distance(span) < distance(best) ? span : best);
      props.onRecordFocus(nearest.index);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || range === null) return;
    event.preventDefault();
    onRangeChange(null);
  };

  const showsEarlierBoundary = props.hasEarlierRecords && domainStart === model.start;
  const tooltipCell = tooltipIndex === null ? undefined : props.cellsByIndex.get(tooltipIndex);
  const animateClass = animateViewport ? "motion-safe:transition-[left] motion-safe:duration-[180ms] motion-safe:ease-out" : "";

  return (
    <section ref={rootRef} className={rootClass} aria-label={trajectoryCopy.timeline.aria}>
      <div className={plotClass}>
        <LaneLabels />
        <div
          ref={trackRef}
          className={`relative touch-none overflow-hidden focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-blue-9 ${panning ? "cursor-grabbing" : "cursor-crosshair"}`}
          aria-label={trajectoryCopy.timeline.overviewAria}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={() => {
            dragRef.current = null;
            panRef.current = null;
            setDraft(null);
            setHover(null);
            setPanning(false);
          }}
          onPointerLeave={() => {
            if (dragRef.current === null && panRef.current === null) setHover(null);
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            onRangeChange(null);
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {showsEarlierBoundary ? <EarlierHistoryBoundary loading={loadingEarlier} onLoad={loadEarlier} /> : null}
          {hover && hover.recordIndex === null && draft === null ? (
            <div
              data-timeline-hover-line=""
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 z-[4] w-0.5 bg-blue-9"
              style={{ left: `clamp(0px, calc(${hover.fraction * 100}% - 1px), calc(100% - 2px))` }}
            />
          ) : null}
          {visibleRange ? (
            <>
              <div
                aria-hidden="true"
                className={`pointer-events-none absolute inset-y-0 z-[1] min-w-px ${draft ? "bg-blue-9/18" : "bg-blue-9/12"} shadow-[-100vw_0_0_100vw_color-mix(in_srgb,var(--color-dls-surface)_58%,transparent),100vw_0_0_100vw_color-mix(in_srgb,var(--color-dls-surface)_58%,transparent)]`}
                style={{ left: `${visibleRange.start * 100}%`, width: `${(visibleRange.end - visibleRange.start) * 100}%` }}
              />
              <div
                aria-hidden="true"
                className={`pointer-events-none absolute inset-y-0 z-[4] min-w-px before:absolute before:inset-y-0 before:left-0 before:bg-blue-9 before:content-[''] after:absolute after:inset-y-0 after:right-0 after:bg-blue-9 after:content-[''] ${draft ? "before:w-0.5 after:w-0.5" : "before:w-[3px] after:w-[3px]"}`}
                style={{ left: `${visibleRange.start * 100}%`, width: `${(visibleRange.end - visibleRange.start) * 100}%` }}
              />
            </>
          ) : null}
          <div aria-hidden="true" className={`pointer-events-none absolute inset-y-0 z-[3] ${animateClass}`} style={domainStyle}>
            {model.turnBoundaries
              .filter((boundary) => boundary.time > model.start && boundary.time >= domainStart && boundary.time <= domainStart + domainDuration)
              .map((boundary) => (
                <span
                  key={boundary.turn}
                  data-turn={boundary.turn}
                  className="absolute inset-y-0 w-[0.5px] bg-dls-border"
                  style={{ left: `${(boundary.time - model.start) / fullDuration * 100}%` }}
                />
              ))}
          </div>
          <div data-timeline-domain="" className={`absolute inset-y-[7px] z-[2] ${animateClass}`} style={domainStyle}>
            {model.spans
              .filter((span) => span.index === selectedIndex || (span.end >= domainStart && span.start <= domainStart + domainDuration))
              .map((span) => {
                const widthPercent = (span.end - span.start) / fullDuration * 100;
                const gap = `min(${widthPercent * 0.08}%, 1px)`;
                const cell = props.cellsByIndex.get(span.index);
                const ttft = ttftFraction(cell);
                const current = span.index === selectedIndex;
                const hovered = hoveredIndex === span.index && !current;
                const outside = activeRange !== null && !(span.start <= activeRange.end && span.end >= activeRange.start);
                const searchMiss = searchMatchIndexes !== null && !searchMatchIndexes.has(span.index);
                const color = span.isError ? "bg-red-9" : SPAN_COLOR[span.kind];
                return (
                  <span
                    key={span.index}
                    aria-hidden="true"
                    data-timeline-span={span.kind}
                    data-timeline-record-index={span.index}
                    data-current={current || undefined}
                    className={[
                      "absolute h-2 min-w-0.5 rounded-[1px]",
                      color,
                      current || hovered ? "z-[1] opacity-100" : "",
                      current ? "shadow-[0_0_0_1px_var(--color-dls-surface-muted),0_0_0_2px_var(--color-blue-9)]" : "",
                      hovered ? "shadow-[0_0_0_1px_var(--color-dls-surface-muted),0_0_0_2px_color-mix(in_srgb,var(--color-blue-9)_80%,transparent)]" : "",
                      !current && !hovered && searchMiss ? "opacity-[0.14]" : !current && !hovered && outside ? "opacity-20" : "",
                    ].join(" ")}
                    style={{
                      top: `${span.lane * 14}px`,
                      left: `calc(${(span.start - model.start) / fullDuration * 100}% + ${gap})`,
                      width: `max(2px, calc(${widthPercent}% - ${gap} - ${gap}))`,
                      ...(ttft === null || span.isError ? {} : {
                        background: `linear-gradient(to right, color-mix(in srgb, var(--color-violet-10) 54%, var(--color-dls-surface-muted)) 0, color-mix(in srgb, var(--color-violet-10) 54%, var(--color-dls-surface-muted)) ${ttft * 100}%, var(--color-violet-10) ${ttft * 100}%, var(--color-violet-10) 100%)`,
                      }),
                    }}
                  />
                );
              })}
          </div>
        </div>
      </div>
      {tooltipCell && hover ? (
        <div
          role="tooltip"
          className="pointer-events-none absolute top-[54px] z-10 max-w-64 whitespace-pre rounded-md bg-dls-surface px-2 py-1 text-[11px] leading-4 text-dls-text shadow-[0_4px_16px_rgba(0,0,0,0.16)]"
          style={{ left: `clamp(0px, ${hover.x + 44}px, calc(100% - 16rem))` }}
        >
          {tooltipText(tooltipCell)}
        </div>
      ) : null}
    </section>
  );
});
