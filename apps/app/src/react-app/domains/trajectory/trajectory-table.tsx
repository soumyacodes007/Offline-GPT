/** Turn-aware event ledger (ported from DeepSeek Harness `TrajectoryTable`). */
import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { requestLabel, trajectoryCopy, turnLabel } from "./trajectory-copy";
import { KIND_ICON, KIND_TAG_CLASS } from "./trajectory-kind";
import { toolResultPreview, type TrajectoryRequest } from "./trajectory-model";
import type { TrajectoryRow } from "./trajectory-records";
import type { TrajectorySelection } from "./trajectory-inspector";

const BOTTOM_FOLLOW_THRESHOLD_PX = 2;
const VIRTUALIZATION_THRESHOLD = 100;
const ROW_HEIGHT = 30;
const SUMMARY_ROW_HEIGHT = 20;

export type TrajectoryTableProps = {
  rows: readonly TrajectoryRow[];
  requests: ReadonlyMap<number, TrajectoryRequest>;
  selection: TrajectorySelection | null;
  activeTurn: number | null;
  timelineFocusIndexes: ReadonlySet<number> | null;
  focusRequest: { index: number } | null;
  hasEarlierRecords: boolean;
  loadingEarlier: boolean;
  loading: boolean;
  onLoadEarlier?: () => void;
  onSelect: (selection: TrajectorySelection | null) => void;
  onExpandSummary: (row: TrajectoryRow) => void;
  onToggleTurn: (turn: number) => void;
  onToggleCalls: (row: TrajectoryRow, position: number) => void;
  canToggleCalls: (row: TrajectoryRow, position: number) => boolean;
  canToggleTurn: (turn: number) => boolean;
  inspector: ReactNode;
};

export function TrajectoryTable(props: TrajectoryTableProps) {
  const { rows } = props;
  const paneRef = useRef<HTMLDivElement | null>(null);
  const followsTail = useRef(true);
  const virtualized = rows.length > VIRTUALIZATION_THRESHOLD;
  const historyOffset = props.hasEarlierRecords ? 1 : 0;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => paneRef.current,
    estimateSize: (index) => rows[index]?.summary !== undefined ? SUMMARY_ROW_HEIGHT : ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 12,
    scrollMargin: props.hasEarlierRecords ? ROW_HEIGHT : 0,
    enabled: virtualized,
  });

  const scrollToTail = useCallback(() => {
    const pane = paneRef.current;
    if (!pane) return;
    if (virtualized && rows.length > 0) virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    pane.scrollTop = pane.scrollHeight;
  }, [rows.length, virtualized, virtualizer]);

  // The ledger opens at the tail and keeps following it until the user
  // scrolls upward, so streaming records do not interrupt inspection.
  useLayoutEffect(() => {
    if (followsTail.current) scrollToTail();
  }, [rows, scrollToTail]);

  useEffect(() => {
    const focus = props.focusRequest;
    if (!focus) return;
    const position = rows.findIndex((row) => row.summary === undefined && row.cell.index === focus.index);
    if (position < 0) return;
    followsTail.current = false;
    if (virtualized) {
      virtualizer.scrollToIndex(position, { align: "auto" });
      return;
    }
    paneRef.current?.querySelector(`[data-record-index="${focus.index}"]`)?.scrollIntoView({ block: "nearest" });
    // Only a new focus request should scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focusRequest]);

  const items = virtualized
    ? virtualizer.getVirtualItems().map((item) => ({ position: item.index, row: rows[item.index] }))
    : rows.map((row, position) => ({ position, row }));
  const virtualItems = virtualizer.getVirtualItems();
  const virtualTop = virtualized && virtualItems.length ? virtualItems[0].start - (props.hasEarlierRecords ? ROW_HEIGHT : 0) : 0;
  const virtualBottom = virtualized && virtualItems.length ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end : 0;
  const selectedIndex = props.selection?.kind === "record" ? props.selection.index : null;
  const selectedRequest = props.selection?.kind === "request" ? props.selection.number : null;

  return (
    <div className="relative flex min-h-0 w-full flex-1 overflow-hidden bg-dls-surface">
      <div
        ref={paneRef}
        data-trajectory-scroll=""
        className="@container/trajectory relative min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
        onScroll={(event) => {
          const pane = event.currentTarget;
          followsTail.current = pane.scrollHeight - pane.clientHeight - pane.scrollTop <= BOTTOM_FOLLOW_THRESHOLD_PX;
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) props.onSelect(null);
        }}
      >
        {props.loading ? (
          <div role="status" aria-live="polite" className="pointer-events-none sticky top-0 z-[5] h-0 overflow-visible">
            <span className="box-border flex h-[30px] w-full items-center justify-center gap-1.5 border-b-[0.5px] border-dls-border bg-dls-surface text-[12px] text-dls-secondary">
              <span className="size-1.5 animate-pulse rounded-full bg-blue-9" aria-hidden="true" />
              {trajectoryCopy.history.loading}
            </span>
          </div>
        ) : null}
        <table className="w-full min-w-0 table-fixed border-separate border-spacing-0 bg-dls-surface text-[12px] leading-4 text-dls-text" aria-rowcount={rows.length + historyOffset}>
          <colgroup>
            <col className="w-[122px] @max-[620px]/trajectory:w-[50px] motion-safe:transition-[width] motion-safe:duration-[180ms]" />
            <col />
          </colgroup>
          <tbody>
            {props.hasEarlierRecords ? (
              <tr data-history-load="" aria-rowindex={1}>
                <td colSpan={2} className="h-[30px] p-0">
                  <button
                    type="button"
                    disabled={props.loadingEarlier || !props.onLoadEarlier}
                    onClick={props.onLoadEarlier}
                    className="flex h-[29px] w-full cursor-pointer items-center justify-center gap-1.5 border-0 bg-dls-surface text-[12px] text-dls-secondary hover:bg-dls-hover hover:text-dls-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-9 disabled:cursor-default disabled:hover:bg-dls-surface"
                  >
                    {props.loadingEarlier ? <span className="size-1.5 animate-pulse rounded-full bg-blue-9" aria-hidden="true" /> : null}
                    {props.loadingEarlier ? trajectoryCopy.history.loadingEarlier : trajectoryCopy.history.loadEarlier}
                  </button>
                </td>
              </tr>
            ) : null}
            {virtualTop > 0 ? (
              <tr aria-hidden="true" data-virtual-spacer="top" className="pointer-events-none">
                <td colSpan={2} className="border-0 p-0" style={{ height: virtualTop }} />
              </tr>
            ) : null}
            {items.map(({ position, row }) => (
              <LedgerRow
                key={row.key}
                row={row}
                position={position}
                first={position === 0}
                rowIndex={position + 1 + historyOffset}
                request={row.cell.request === undefined ? undefined : props.requests.get(row.cell.request)}
                selected={row.summary === undefined && selectedIndex === row.cell.index}
                requestSelected={row.cell.request !== undefined && selectedRequest === row.cell.request}
                activeTurn={props.activeTurn}
                timelineFocus={row.summary !== undefined || props.timelineFocusIndexes === null
                  ? undefined
                  : props.timelineFocusIndexes.has(row.cell.index) ? "inside" : "outside"}
                props={props}
              />
            ))}
            {virtualBottom > 0 ? (
              <tr aria-hidden="true" data-virtual-spacer="bottom" className="pointer-events-none">
                <td colSpan={2} className="border-0 p-0" style={{ height: virtualBottom }} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {props.inspector}
    </div>
  );
}

function LedgerRow(input: {
  row: TrajectoryRow;
  position: number;
  first: boolean;
  rowIndex: number;
  request: TrajectoryRequest | undefined;
  selected: boolean;
  requestSelected: boolean;
  activeTurn: number | null;
  timelineFocus: "inside" | "outside" | undefined;
  props: TrajectoryTableProps;
}) {
  const { row, position, props, request } = input;
  const cell = row.cell;
  const summary = row.summary;
  const isSummary = summary !== undefined;
  const result = isSummary ? undefined : toolResultPreview(cell);
  const error = cell.state === "error";
  const turnActive = cell.turn !== null && input.activeTurn === cell.turn;
  const separator = row.turnStart && !input.first ? "relative overflow-visible before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:z-[1] before:h-0.5 before:-translate-y-1/2 before:bg-gray-a4 before:content-['']" : "";
  const label = isSummary
    ? `Collapsed ${row.summaryKind === "turn" ? "turn" : "assistant"} summary, ${summary}`
    : `${cell.request === undefined ? "" : `Request ${cell.request}, `}${trajectoryCopy.kind[cell.kind]}, ${cell.text || "no content"}`;
  const height = isSummary ? "h-5" : "h-[30px]";
  const td = `box-border ${height} overflow-hidden text-ellipsis whitespace-nowrap border-b-[0.5px] border-gray-a3 px-2 ${separator}`;

  return (
    <tr
      tabIndex={0}
      aria-rowindex={input.rowIndex}
      aria-label={label}
      aria-selected={input.selected}
      data-kind={cell.kind}
      data-testid={isSummary ? `trajectory-summary-${row.summaryKind}` : `trajectory-row-${cell.kind}`}
      data-record-index={isSummary ? undefined : cell.index}
      data-collapsed-summary={row.summaryKind}
      data-turn-start={row.turnStart || undefined}
      data-error={error || undefined}
      data-running={cell.state === "running" || undefined}
      data-selected={input.selected || undefined}
      data-timeline-focus={input.timelineFocus}
      className={[
        "outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-blue-9)] motion-safe:transition-[background-color,opacity] motion-safe:duration-[120ms]",
        isSummary ? "cursor-pointer hover:bg-dls-hover" : "cursor-default",
        input.selected ? "bg-dls-active" : isSummary ? "" : "hover:bg-dls-hover",
        input.timelineFocus === "outside" ? "opacity-[0.24]" : "",
      ].join(" ")}
      onClick={() => {
        if (isSummary) props.onExpandSummary(row);
        else props.onSelect({ kind: "record", index: cell.index });
      }}
      onDoubleClick={(event) => {
        if (isSummary) return;
        if (cell.kind === "message" && props.canToggleCalls(row, position)) {
          event.preventDefault();
          props.onToggleCalls(row, position);
          return;
        }
        if (row.turnStart && cell.turn !== null && props.canToggleTurn(cell.turn)) {
          event.preventDefault();
          props.onToggleTurn(cell.turn);
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (isSummary) props.onExpandSummary(row);
        else props.onSelect({ kind: "record", index: cell.index });
      }}
    >
      <td className={`${td} relative !overflow-visible pl-9 pr-1 @max-[620px]/trajectory:pl-7 @max-[620px]/trajectory:pr-[3px]`}>
        {request && !isSummary ? (
          <button
            type="button"
            aria-label={requestLabel(request.number)}
            aria-pressed={input.requestSelected}
            data-label={requestLabel(request.number)}
            data-request-status={request.status}
            onClick={(event) => {
              event.stopPropagation();
              props.onSelect({ kind: "request", number: request.number });
            }}
            onDoubleClick={(event) => event.stopPropagation()}
            className={[
              "group/request absolute left-3 -top-2 z-[6] size-4 cursor-pointer border-0 bg-transparent p-0 outline-none @max-[620px]/trajectory:left-1.5",
              "before:absolute before:left-[5.5px] before:top-[5.5px] before:size-[5px] before:rounded-full before:content-[''] before:shadow-[0_0_0_2px_var(--color-dls-surface)] before:transition-[background,box-shadow] before:duration-[120ms]",
              request.status === "error"
                ? "before:bg-red-9"
                : input.requestSelected
                  ? "before:bg-blue-3 before:shadow-[0_0_0_1.5px_var(--color-blue-9)]"
                  : "before:bg-gray-9 hover:before:bg-dls-text focus-visible:before:bg-dls-text",
              "after:pointer-events-none after:absolute after:left-[17px] after:top-0.5 after:w-max after:select-none after:whitespace-nowrap after:rounded-[2px] after:border-[0.5px] after:border-gray-a4 after:bg-dls-surface after:px-1 after:font-mono after:text-[9px] after:leading-3 after:text-dls-secondary after:opacity-0 after:shadow-[0_2px_6px_rgba(0,0,0,0.12)] after:content-[attr(data-label)] after:-translate-x-0.5 after:transition-[opacity,transform] after:duration-[120ms] hover:after:translate-x-0 hover:after:opacity-100 focus-visible:after:translate-x-0 focus-visible:after:opacity-100",
            ].join(" ")}
          />
        ) : null}
        {turnActive && cell.kind !== "system" ? (
          <span aria-hidden="true" className={`pointer-events-none absolute left-0 z-[4] w-0.5 ${error ? "bg-red-4" : "bg-blue-5"} -top-px ${row.turnEnd ? "bottom-0" : "-bottom-px"}`} />
        ) : null}
        {input.selected ? (
          <span aria-hidden="true" className={`pointer-events-none absolute inset-y-0 left-0 z-[5] w-[3px] ${error ? "bg-red-9" : "bg-dls-text"}`} />
        ) : null}
        {!isSummary && row.turnStart ? (
          <span
            aria-label={turnLabel(cell.turn)}
            className={`absolute left-0 top-0 z-[3] inline-grid w-max select-none items-center whitespace-nowrap rounded-br-[2px] px-[5px] py-px font-mono text-[8px] leading-[10px] tabular-nums ${turnActive ? "bg-blue-5 text-blue-11" : "bg-gray-3 text-gray-10"}`}
          >
            <span aria-hidden="true" className="col-start-1 row-start-1 max-w-16 overflow-hidden @max-[620px]/trajectory:max-w-0 @max-[620px]/trajectory:opacity-0">{turnLabel(cell.turn)}</span>
            <span aria-hidden="true" className="col-start-1 row-start-1 max-w-0 overflow-hidden opacity-0 @max-[620px]/trajectory:max-w-16 @max-[620px]/trajectory:opacity-100">{cell.turn === null ? "—" : `#${cell.turn}`}</span>
          </span>
        ) : null}
        <div className="flex h-full min-w-0 items-center justify-start">
          {!isSummary ? (
            <span className="flex w-[76px] flex-none items-end justify-end @max-[620px]/trajectory:w-[19px]">
              <span
                data-role-kind={cell.kind}
                title={trajectoryCopy.kind[cell.kind]}
                className={`box-border inline-flex h-[19px] flex-none select-none items-center rounded-[3px] border border-transparent px-[5px] text-[10px] font-[650] leading-4 tracking-[0.035em] @max-[620px]/trajectory:w-[19px] @max-[620px]/trajectory:justify-center @max-[620px]/trajectory:px-0 ${cell.kind === "message" ? "w-full justify-center" : ""} ${KIND_TAG_CLASS[cell.kind]}`}
              >
                <span aria-hidden="true" className="hidden h-[13px] w-[13px] items-center justify-center @max-[620px]/trajectory:inline-flex">{KIND_ICON[cell.kind]}</span>
                <span className="inline-block max-w-[72px] overflow-hidden whitespace-nowrap @max-[620px]/trajectory:hidden">{trajectoryCopy.kind[cell.kind]}</span>
              </span>
            </span>
          ) : null}
        </div>
      </td>
      <td className={`${td} pl-1 text-dls-text`}>
        {isSummary ? (
          <span className="flex min-w-0 items-center text-[12px] leading-4 text-dls-secondary" title={summary}>
            <span className="mr-1.5 flex-none select-none font-semibold text-gray-10">…</span>
            <span className="min-w-0 truncate">{summary}</span>
          </span>
        ) : result === undefined ? (
          <span className={`block min-w-0 truncate ${error && cell.kind === "message" ? "text-red-11" : ""} ${cell.text === trajectoryCopy.record.toolCallOnly ? "text-gray-10" : ""}`} title={cell.text}>
            {cell.text || <span className="text-gray-9">{trajectoryCopy.record.noContent}</span>}
          </span>
        ) : (
          <span
            className="grid min-w-0 grid-cols-[clamp(180px,calc(36cqw-56px),480px)_minmax(0,1fr)] items-center gap-2 font-mono text-[12px]"
            title={`${cell.text} → ${result}`}
          >
            <span className="min-w-0 truncate">
              <span className="text-dls-text">{cell.toolName}</span>
              <span className="ml-[7px] text-dls-secondary">{cell.text.slice((cell.toolName ?? "").length).trim()}</span>
            </span>
            <span className={`flex min-w-0 items-center ${error ? "text-red-11" : "text-dls-secondary"}`}>
              <span className="mr-2 flex-none text-gray-9">→</span>
              <span className={`min-w-0 truncate ${result === trajectoryCopy.record.noOutput ? "text-gray-9" : ""}`}>{result}</span>
            </span>
          </span>
        )}
      </td>
    </tr>
  );
}
