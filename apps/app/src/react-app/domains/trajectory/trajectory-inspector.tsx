/** Local record / request inspector beside the ledger (ported from DeepSeek Harness). */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { MarkdownBlock } from "@/react-app/domains/session/surface/markdown";
import {
  formatDurationMs,
  formatStartedAt,
  formatTokens,
  requestLabel,
  trajectoryCopy,
  turnLabel,
} from "./trajectory-copy";
import { stringifyPayload, type TrajectoryCell, type TrajectoryRecordState, type TrajectoryRequest, type TrajectoryUsage } from "./trajectory-model";
import { KIND_TAG_CLASS } from "./trajectory-kind";

const DETAILS_MIN_WIDTH = 320;
const DETAILS_MAX_WIDTH = 720;
const TABLE_MIN_WIDTH = 280;
const DETAILS_RESIZE_STEP = 16;

type DetailTab = "overview" | "preview" | "raw" | "input" | "output" | "usage" | "timing";

export type TrajectorySelection =
  | { kind: "record"; index: number }
  | { kind: "request"; number: number };

function clampWidth(width: number, splitWidth: number) {
  const max = Math.max(DETAILS_MIN_WIDTH, Math.min(DETAILS_MAX_WIDTH, splitWidth - TABLE_MIN_WIDTH));
  return Math.round(Math.min(Math.max(width, DETAILS_MIN_WIDTH), max));
}

function statusLabel(state: TrajectoryRecordState) {
  return state === "error" ? trajectoryCopy.status.failed : state === "running" ? trajectoryCopy.status.pending : trajectoryCopy.status.completed;
}

function tabsFor(cell: TrajectoryCell | undefined, request: TrajectoryRequest | undefined): { id: DetailTab; label: string }[] {
  const tab = trajectoryCopy.tab;
  if (request) return [{ id: "overview", label: tab.summary }, { id: "usage", label: tab.usage }, { id: "timing", label: tab.timing }];
  if (!cell) return [];
  if (cell.kind === "tool") {
    return [
      { id: "overview", label: tab.summary },
      { id: "input", label: tab.payload },
      ...(cell.output !== undefined ? [{ id: "output" as const, label: tab.result }] : []),
      { id: "timing", label: tab.timing },
    ];
  }
  return [{ id: "overview", label: tab.summary }, { id: "preview", label: tab.preview }, { id: "raw", label: tab.raw }];
}

function Row(props: { label: string; children: ReactNode; error?: boolean; indent?: boolean }) {
  return (
    <div className="grid min-h-[22px] grid-cols-[94px_minmax(0,1fr)] items-center px-3.5">
      <dt className={`text-gray-10 ${props.indent ? "pl-3" : ""}`}>{props.label}</dt>
      <dd className={`m-0 min-w-0 truncate ${props.error ? "text-red-11" : "text-dls-text"}`}>{props.children}</dd>
    </div>
  );
}

function Overview(props: { children: ReactNode }) {
  return <dl className="m-0 py-2 text-[13px] leading-5">{props.children}</dl>;
}

function Empty(props: { children: ReactNode }) {
  return <p className="m-0 px-3.5 py-3 text-[13px] text-gray-9">{props.children}</p>;
}

function Pre(props: { children: string; error?: boolean }) {
  return (
    <pre className={`m-0 whitespace-pre-wrap break-words px-3.5 py-2.5 font-mono text-[11px] leading-[17px] ${props.error ? "text-red-11" : "text-dls-text"}`}>
      {props.children}
    </pre>
  );
}

function StartedAt(props: { timestamp: number | null }) {
  const [unix, setUnix] = useState(false);
  if (props.timestamp === null) return <>{trajectoryCopy.timing.notAvailable}</>;
  return (
    <button
      type="button"
      className="cursor-pointer select-text border-0 bg-transparent p-0 text-inherit"
      title={unix ? trajectoryCopy.timing.showLocalTime : trajectoryCopy.timing.showUnixTimestamp}
      onClick={() => setUnix((value) => !value)}
    >
      {unix ? (props.timestamp / 1_000).toFixed(3) : formatStartedAt(props.timestamp)}
    </button>
  );
}

function UsageRows(props: { usage: TrajectoryUsage | undefined }) {
  const usage = props.usage;
  if (!usage) return <Empty>{trajectoryCopy.usage.notReported}</Empty>;
  const copy = trajectoryCopy.usage;
  return (
    <Overview>
      {usage.input !== undefined ? <Row label={copy.input}>{formatTokens(usage.input)}</Row> : null}
      {usage.cacheRead ? <Row label={copy.cached} indent>{formatTokens(usage.cacheRead)}</Row> : null}
      {usage.cacheWrite ? <Row label={copy.cacheCreated} indent>{formatTokens(usage.cacheWrite)}</Row> : null}
      {usage.output !== undefined ? <Row label={copy.output}>{formatTokens(usage.output)}</Row> : null}
      {usage.reasoning ? <Row label={copy.reasoning} indent>{formatTokens(usage.reasoning)}</Row> : null}
    </Overview>
  );
}

function TimingRows(props: { startedAt: number | null; completedAt: number | null; firstTokenAt?: number | null; durationMs: number | null; running: boolean; outputTokens?: number }) {
  const copy = trajectoryCopy.timing;
  const ttft = props.startedAt !== null && props.firstTokenAt != null ? props.firstTokenAt - props.startedAt : null;
  const generation = props.firstTokenAt != null && props.completedAt !== null ? props.completedAt - props.firstTokenAt : null;
  const throughput = props.outputTokens === undefined
    ? copy.usageUnavailable
    : generation === null
      ? copy.firstTokenUnavailable
      : generation <= 0 ? copy.durationTooShort : `${(props.outputTokens / (generation / 1_000)).toFixed(1)} tok/s`;
  return (
    <Overview>
      <Row label={copy.started}><StartedAt timestamp={props.startedAt} /></Row>
      <Row label={props.firstTokenAt === undefined ? copy.duration : copy.totalDuration}>
        {props.durationMs !== null ? formatDurationMs(props.durationMs) : props.running ? trajectoryCopy.status.pending : copy.notAvailable}
      </Row>
      {props.firstTokenAt !== undefined ? (
        <>
          <Row label={copy.ttft}>{ttft !== null ? formatDurationMs(Math.max(0, ttft)) : copy.firstTokenUnavailable}</Row>
          <Row label={copy.generation}>{generation !== null ? formatDurationMs(Math.max(0, generation)) : props.running ? trajectoryCopy.status.pending : copy.firstTokenUnavailable}</Row>
          <Row label={copy.throughput}>{props.running ? trajectoryCopy.status.pending : throughput}</Row>
        </>
      ) : null}
      <Row label={copy.source}>{props.running ? copy.sessionTimestampsRunning : copy.sessionTimestamps}</Row>
    </Overview>
  );
}

function PreviewBody(props: { cell: TrajectoryCell }) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const { cell } = props;
  if (!cell.body && !cell.reasoning && !cell.attachments?.length) return <Empty>{trajectoryCopy.record.noContent}</Empty>;
  return (
    <div className="px-3.5 py-3 text-[13px]">
      {cell.reasoning ? (
        <div className="mb-3">
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-[13px] text-dls-secondary hover:text-dls-text"
            aria-expanded={thinkingOpen}
            onClick={() => setThinkingOpen((value) => !value)}
          >
            <ChevronRight size={12} className={`transition-transform ${thinkingOpen ? "rotate-90" : ""}`} />
            {trajectoryCopy.record.thinking}
          </button>
          {thinkingOpen ? (
            <div className="mt-1.5 border-l-2 border-dls-border pl-3 text-[13px] leading-5 text-dls-secondary [&_h1]:text-[13px] [&_h2]:text-[13px] [&_h3]:text-[13px] [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold">
              <MarkdownBlock text={cell.reasoning} />
            </div>
          ) : null}
        </div>
      ) : null}
      {cell.body ? <MarkdownBlock text={cell.body} streaming={cell.state === "running"} /> : null}
      {cell.attachments?.length ? (
        <ul className="mt-3 flex list-none flex-col gap-1 p-0">
          {cell.attachments.map((file, index) => (
            <li key={`${file.name}:${index}`} className="flex min-w-0 items-center gap-2 text-[12px]">
              <span className="truncate text-dls-text" title={file.name}>{file.name}</span>
              <span className="flex-none text-gray-9">{file.mime}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export type TrajectoryInspectorProps = {
  selection: TrajectorySelection;
  cell: TrajectoryCell | undefined;
  request: TrajectoryRequest | undefined;
  onClose: () => void;
};

/** Resizable inspector pane; its width persists while the view is mounted. */
export function TrajectoryInspector(props: TrajectoryInspectorProps) {
  const { cell, request } = props;
  const [width, setWidth] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; splitWidth: number } | null>(null);
  const tabs = tabsFor(request ? undefined : cell, request);
  const selectionKey = props.selection.kind === "record" ? `record:${props.selection.index}` : `request:${props.selection.number}`;
  useEffect(() => {
    setActiveTab((current) => tabs.some((tab) => tab.id === current) ? current : "overview");
    // Tab availability only changes with the selected record.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);
  const tab = tabs.some((candidate) => candidate.id === activeTab) ? activeTab : "overview";

  const header = request ? (
    <>
      <span className="size-[5px] flex-none rounded-full bg-dls-secondary" aria-hidden="true" />
      <span className="flex-none font-mono text-[12px] font-medium leading-4">{requestLabel(request.number)}</span>
      <span className="min-w-0 truncate font-mono text-[11px] leading-4 text-gray-10">{turnLabel(request.turn)}</span>
    </>
  ) : cell ? (
    <>
      <span className={`inline-flex h-[19px] flex-none items-center rounded-[3px] px-[5px] text-[10px] font-[650] leading-4 tracking-[0.035em] ${KIND_TAG_CLASS[cell.kind]}`}>
        {trajectoryCopy.kind[cell.kind]}
      </span>
      <span className="min-w-0 truncate font-mono text-[11px] leading-4 text-gray-10">
        {cell.kind === "compacted" ? turnLabel(cell.turn) : `${turnLabel(cell.turn)} · ${cell.group}`}
      </span>
    </>
  ) : null;

  let body: ReactNode = null;
  if (request) {
    const copy = trajectoryCopy.details;
    body = tab === "overview" ? (
      <Overview>
        <Row label={copy.status} error={request.status === "error"}>{statusLabel(request.status)}</Row>
        {request.provider ? <Row label={copy.provider}>{request.provider}</Row> : null}
        {request.model ? <Row label={copy.model}>{request.model}</Row> : null}
        {request.agent ? <Row label={copy.agent}>{request.agent}</Row> : null}
        <Row label={copy.toolCalls}>{request.toolCalls}</Row>
        {request.finish ? <Row label={copy.finish}>{request.finish}</Row> : null}
        {request.cost ? <Row label={copy.cost}>${request.cost.toFixed(4)}</Row> : null}
        {request.retries > 0 ? <Row label={copy.retry}>{request.retries}</Row> : null}
        {request.error ? <Row label={copy.error} error>{request.error}</Row> : null}
      </Overview>
    ) : tab === "usage" ? (
      <div className="pb-2.5 pt-1">
        <section>
          <h4 className="m-0 select-none px-3.5 pb-px pt-1 text-[13px] font-semibold text-dls-secondary">{trajectoryCopy.usage.thisRequest}</h4>
          <UsageRows usage={request.usage} />
        </section>
        <section className="mt-2">
          <h4 className="m-0 select-none px-3.5 pb-px pt-1 text-[13px] font-semibold text-dls-secondary">{trajectoryCopy.usage.sessionCumulative}</h4>
          <UsageRows usage={request.cumulativeUsage} />
        </section>
      </div>
    ) : (
      <TimingRows
        startedAt={request.startedAt}
        completedAt={request.completedAt}
        firstTokenAt={request.firstTokenAt}
        durationMs={request.startedAt !== null && request.completedAt !== null ? request.completedAt - request.startedAt : null}
        running={request.status === "running"}
        outputTokens={request.usage?.output}
      />
    );
  } else if (cell) {
    const copy = trajectoryCopy.details;
    if (tab === "overview") {
      body = (
        <Overview>
          <Row label={copy.status} error={cell.state === "error"}>{statusLabel(cell.state)}</Row>
          {cell.request !== undefined ? <Row label="Request">{requestLabel(cell.request)}</Row> : null}
          {cell.toolName ? <Row label={copy.tool}>{cell.toolName}</Row> : null}
          {cell.toolTitle ? <Row label={copy.title}>{cell.toolTitle}</Row> : null}
          {cell.agent ? <Row label={copy.agent}>{cell.agent}</Row> : null}
          <Row label={trajectoryCopy.timing.started}><StartedAt timestamp={cell.startedAt} /></Row>
          {cell.durationMs !== null && cell.durationMs > 0 ? <Row label={trajectoryCopy.timing.duration}>{formatDurationMs(cell.durationMs)}</Row> : null}
          {cell.attachments?.length ? <Row label={copy.attachments}>{cell.attachments.length}</Row> : null}
          {cell.error ? <Row label={copy.error} error>{cell.error}</Row> : null}
        </Overview>
      );
    } else if (tab === "preview") {
      body = <PreviewBody cell={cell} />;
    } else if (tab === "raw") {
      body = <Pre>{stringifyPayload(cell.raw)}</Pre>;
    } else if (tab === "input") {
      body = cell.input === undefined ? <Empty>{trajectoryCopy.record.noPayload}</Empty> : <Pre>{stringifyPayload(cell.input)}</Pre>;
    } else if (tab === "output") {
      body = cell.output ? <Pre error={cell.state === "error"}>{cell.output}</Pre> : <Empty>{trajectoryCopy.record.noOutput}</Empty>;
    } else {
      body = (
        <TimingRows
          startedAt={cell.startedAt}
          completedAt={cell.startedAt !== null && cell.durationMs !== null ? cell.startedAt + cell.durationMs : null}
          durationMs={cell.durationMs}
          running={cell.state === "running"}
        />
      );
    }
  }

  return (
    <aside
      aria-label={trajectoryCopy.details.event}
      className="relative flex min-h-0 min-w-0 max-w-[calc(100%-280px)] flex-none flex-col border-l-[0.5px] border-dls-border bg-dls-surface"
      style={{ width: width ?? "clamp(320px, 38%, 440px)" }}
    >
      <div
        role="separator"
        aria-label={trajectoryCopy.details.resize}
        aria-orientation="vertical"
        aria-controls="trajectory-detail-panel"
        tabIndex={0}
        title={trajectoryCopy.details.resizeTitle}
        className="absolute inset-y-0 -left-1 z-[6] w-2 cursor-col-resize touch-none select-none border-0 bg-transparent p-0 outline-none"
        onDoubleClick={() => setWidth(null)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const details = event.currentTarget.parentElement;
          const split = details?.parentElement;
          if (!details || !split) return;
          drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: details.getBoundingClientRect().width, splitWidth: split.getBoundingClientRect().width };
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const state = drag.current;
          if (!state || state.pointerId !== event.pointerId) return;
          setWidth(clampWidth(state.startWidth + state.startX - event.clientX, state.splitWidth));
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { drag.current = null; }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          const details = event.currentTarget.parentElement;
          const split = details?.parentElement;
          if (!details || !split) return;
          const direction = event.key === "ArrowLeft" ? 1 : -1;
          setWidth(clampWidth(details.getBoundingClientRect().width + direction * DETAILS_RESIZE_STEP, split.getBoundingClientRect().width));
          event.preventDefault();
        }}
      />
      <div className="box-border flex h-[42px] flex-none items-center justify-between border-b-[0.5px] border-dls-border pl-3 pr-2">
        <div className="flex min-w-0 items-center gap-2 text-dls-text">{header}</div>
        <button
          type="button"
          aria-label={trajectoryCopy.details.close}
          onClick={props.onClose}
          className="inline-flex size-7 flex-none cursor-pointer items-center justify-center rounded-[5px] border-0 bg-transparent p-0 text-[18px] leading-[18px] text-dls-secondary hover:bg-dls-hover hover:text-dls-text focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-blue-9"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div role="tablist" aria-label={trajectoryCopy.details.event} className="box-border flex h-[34px] w-full min-w-0 flex-none gap-px overflow-x-auto overflow-y-hidden whitespace-nowrap border-b-[0.5px] border-dls-border px-2 [scrollbar-width:none]">
        {tabs.map((item) => (
          <button
            key={item.id}
            id={`trajectory-detail-${item.id}`}
            type="button"
            role="tab"
            aria-controls="trajectory-detail-panel"
            aria-selected={tab === item.id}
            onClick={() => setActiveTab(item.id)}
            className={`relative flex-none cursor-pointer border-0 bg-transparent px-[9px] text-[13px] hover:bg-dls-hover hover:text-dls-text focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-blue-9 ${tab === item.id ? "text-blue-11 after:absolute after:inset-x-[9px] after:bottom-0 after:h-0.5 after:rounded-t-[1px] after:bg-blue-9 after:content-['']" : "text-gray-10"}`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        id="trajectory-detail-panel"
        role="tabpanel"
        aria-labelledby={`trajectory-detail-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
      >
        {body}
      </div>
    </aside>
  );
}
