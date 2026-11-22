/** Trajectory view: toolbar, timing overview, and a turn-aware ledger with an inspector. */
import { useCallback, useDeferredValue, useMemo, useState } from "react";

import type { OfflineGptSessionMessage } from "@/app/lib/offlinegpt-server";
import { useConversationViewStore } from "./conversation-view-store";
import { TrajectoryInspector, type TrajectorySelection } from "./trajectory-inspector";
import { projectTrajectory, trajectorySearchText, type TrajectoryCell, type TrajectoryRequest } from "./trajectory-model";
import { collapseCalls, collapseTurns, filterRows, flattenTrajectory, followingToolRows, type TrajectoryRow } from "./trajectory-records";
import { TrajectoryTable } from "./trajectory-table";
import { TrajectoryTimeline } from "./trajectory-timeline";
import { deriveTrajectoryTimeline, trajectoryTimelineFocusIndexes, type TrajectoryTimeRange } from "./trajectory-timeline-model";
import { TrajectoryToolbar } from "./trajectory-toolbar";

const EMPTY_NUMBERS: ReadonlySet<number> = new Set();
const EMPTY_IDS: ReadonlySet<string> = new Set();

export type TrajectoryViewProps = {
  messages: readonly OfflineGptSessionMessage[];
  busy: boolean;
  loading: boolean;
  hasEarlierRecords: boolean;
  onLoadEarlier?: () => Promise<boolean>;
};

function toggle<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function TrajectoryView(props: TrajectoryViewProps) {
  const projection = useMemo(() => projectTrajectory(props.messages, props.busy), [props.busy, props.messages]);
  const actualDuration = useConversationViewStore((state) => state.trajectoryActualDuration);
  const setActualDuration = useConversationViewStore((state) => state.setTrajectoryActualDuration);
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(EMPTY_NUMBERS);
  const [collapsedCalls, setCollapsedCalls] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const [searchQuery, setSearchQuery] = useState("");
  const deferredQuery = useDeferredValue(searchQuery.trim().toLowerCase());
  const [range, setRange] = useState<TrajectoryTimeRange | null>(null);
  const [selection, setSelection] = useState<TrajectorySelection | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ index: number } | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const cellsByIndex = useMemo(() => new Map(projection.cells.map((cell) => [cell.index, cell])), [projection.cells]);
  const requests = useMemo(() => new Map(projection.requests.map((request) => [request.number, request])), [projection.requests]);
  const searchHaystacks = useMemo(() => projection.cells.map((cell) => [cell.index, trajectorySearchText(cell)] as const), [projection.cells]);
  const searchMatches = useMemo(() => deferredQuery
    ? new Set(searchHaystacks.filter(([, text]) => text.includes(deferredQuery)).map(([index]) => index))
    : null, [deferredQuery, searchHaystacks]);

  const mode = actualDuration ? "duration" : "sequence";
  const timeline = useMemo(() => deriveTrajectoryTimeline(projection.turns, mode), [mode, projection.turns]);
  const timelineFocus = useMemo(() => range === null ? null : trajectoryTimelineFocusIndexes(timeline, range), [range, timeline]);

  const allRows = useMemo(() => flattenTrajectory(projection.turns), [projection.turns]);
  const rows = useMemo(() => searchMatches
    ? filterRows(allRows, searchMatches)
    : collapseCalls(collapseTurns(allRows, collapsedTurns), collapsedCalls), [allRows, collapsedCalls, collapsedTurns, searchMatches]);

  const collapsibleTurns = useMemo(() => projection.turns
    .filter((turn) => turn.turn !== null && turn.groups.flatMap((group) => group.cells).filter((cell) => cell.kind !== "system").length > 1)
    .flatMap((turn) => turn.turn === null ? [] : [turn.turn]), [projection.turns]);
  const collapsibleCalls = useMemo(() => allRows.flatMap((row, position) =>
    row.cell.kind === "message" && allRows[position + 1]?.cell.kind === "tool" ? [row.cell.id] : []), [allRows]);
  const allTurnsCollapsed = collapsibleTurns.length > 0 && collapsibleTurns.every((turn) => collapsedTurns.has(turn));
  const allCallsCollapsed = collapsibleCalls.length > 0 && collapsibleCalls.every((id) => collapsedCalls.has(id));

  const selectedCell: TrajectoryCell | undefined = selection?.kind === "record" ? cellsByIndex.get(selection.index) : undefined;
  const selectedRequest: TrajectoryRequest | undefined = selection?.kind === "request" ? requests.get(selection.number) : undefined;
  const activeTurn = selectedCell?.turn ?? selectedRequest?.turn ?? projection.turns.at(-1)?.turn ?? null;

  const selectRecord = useCallback((index: number) => {
    const turn = cellsByIndex.get(index)?.turn;
    if (turn != null && collapsedTurns.has(turn)) setCollapsedTurns((current) => toggle(current, turn));
    setSelection({ kind: "record", index });
    setFocusRequest({ index });
  }, [cellsByIndex, collapsedTurns]);

  const onSelect = useCallback((next: TrajectorySelection | null) => {
    setSelection(next);
    if (next?.kind === "record" && timelineFocus !== null && !timelineFocus.has(next.index)) setRange(null);
  }, [timelineFocus]);

  const expandSummary = useCallback((row: TrajectoryRow) => {
    if (row.summaryKind === "turn" && row.cell.turn !== null) {
      const turn = row.cell.turn;
      setCollapsedTurns((current) => toggle(current, turn));
    }
    if (row.summaryKind === "assistant") setCollapsedCalls((current) => toggle(current, row.cell.id));
  }, []);

  const loadEarlier = props.onLoadEarlier && !loadingEarlier
    ? () => {
      setLoadingEarlier(true);
      void props.onLoadEarlier?.().finally(() => setLoadingEarlier(false));
    }
    : undefined;

  return (
    <div className="isolate flex size-full min-h-0 flex-col overflow-hidden bg-dls-surface text-dls-text" data-trajectory-view="">
      <TrajectoryToolbar
        actualDuration={actualDuration}
        onActualDurationChange={(next) => {
          setActualDuration(next);
          setRange(null);
        }}
        allTurnsCollapsed={allTurnsCollapsed}
        onToggleAllTurns={() => setCollapsedTurns(allTurnsCollapsed ? EMPTY_NUMBERS : new Set(collapsibleTurns))}
        allCallsCollapsed={allCallsCollapsed}
        onToggleAllCalls={() => setCollapsedCalls(allCallsCollapsed ? EMPTY_IDS : new Set(collapsibleCalls))}
        canCollapseCalls={collapsibleCalls.length > 0}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
      />
      <TrajectoryTimeline
        model={timeline}
        mode={mode}
        cellsByIndex={cellsByIndex}
        range={range}
        selectedIndex={selectedCell?.index ?? null}
        searchMatchIndexes={searchMatches}
        hasEarlierRecords={props.hasEarlierRecords}
        onLoadEarlier={props.onLoadEarlier}
        onRangeChange={setRange}
        onRecordSelect={selectRecord}
        onRecordFocus={(index) => setFocusRequest({ index })}
      />
      <div className="relative isolate z-0 flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <TrajectoryTable
          rows={rows}
          requests={requests}
          selection={selection}
          activeTurn={activeTurn}
          timelineFocusIndexes={timelineFocus}
          focusRequest={focusRequest}
          hasEarlierRecords={props.hasEarlierRecords}
          loadingEarlier={loadingEarlier}
          loading={props.loading}
          onLoadEarlier={loadEarlier}
          onSelect={onSelect}
          onExpandSummary={expandSummary}
          onToggleTurn={(turn) => setCollapsedTurns((current) => toggle(current, turn))}
          onToggleCalls={(row) => setCollapsedCalls((current) => toggle(current, row.cell.id))}
          canToggleCalls={(_row, position) => followingToolRows(rows, position).length > 0}
          canToggleTurn={(turn) => collapsibleTurns.includes(turn)}
          inspector={selection && (selectedCell || selectedRequest) ? (
            <TrajectoryInspector selection={selection} cell={selectedCell} request={selectedRequest} onClose={() => setSelection(null)} />
          ) : null}
        />
      </div>
    </div>
  );
}
