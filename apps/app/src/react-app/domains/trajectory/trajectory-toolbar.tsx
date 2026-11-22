import { Search } from "lucide-react";

import { trajectoryCopy } from "./trajectory-copy";

const copy = trajectoryCopy.toolbar;

const actionClass =
  "inline-flex h-5 flex-none cursor-pointer items-center gap-1 rounded-[5px] border-0 bg-transparent px-[5px] text-[12px] leading-4 text-gray-10 hover:bg-dls-hover hover:text-dls-text focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-blue-9 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-gray-10";

export type TrajectoryToolbarProps = {
  actualDuration: boolean;
  onActualDurationChange: (actualDuration: boolean) => void;
  allTurnsCollapsed: boolean;
  onToggleAllTurns: () => void;
  allCallsCollapsed: boolean;
  onToggleAllCalls: () => void;
  canCollapseCalls: boolean;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
};

/** Sticky Trajectory toolbar: timeline projection, ledger folds, and search. */
export function TrajectoryToolbar(props: TrajectoryToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label={copy.aria}
      className="sticky top-0 z-[4] box-border min-h-8 w-full flex-none border-b-[0.5px] border-dls-border bg-dls-surface"
    >
      <div className="box-border flex min-h-8 w-full flex-wrap items-center gap-x-2 gap-y-1 px-1.5 py-1">
        <div className="flex min-w-0 flex-[0_1_auto] flex-wrap items-center gap-0.5">
          <button
            type="button"
            className={`${actionClass} px-[7px] ${props.actualDuration ? "bg-dls-hover text-dls-text" : ""}`}
            aria-label={copy.useActualDuration}
            aria-pressed={props.actualDuration}
            title={props.actualDuration ? copy.useEqualWidth : copy.useActualDuration}
            onClick={() => props.onActualDurationChange(!props.actualDuration)}
          >
            <svg className="size-3 flex-none stroke-current" viewBox="0 0 16 16" fill="none" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="8" cy="8" r="5.25" />
              <path d="M8 4.75V8l2.25 1.5" />
            </svg>
            {copy.duration}
          </button>
          <FoldButton
            label={copy.turns}
            collapsed={props.allTurnsCollapsed}
            expandLabel={copy.expandTurns}
            collapseLabel={copy.collapseTurns}
            onClick={props.onToggleAllTurns}
          />
          <FoldButton
            label={copy.calls}
            collapsed={props.allCallsCollapsed}
            expandLabel={copy.expandCalls}
            collapseLabel={copy.collapseCalls}
            onClick={props.onToggleAllCalls}
            disabled={!props.canCollapseCalls}
          />
          {/* OpenCode records no nested tool calls inside a tool, so there is
              never anything to fold here; the control keeps DeepSeek's layout. */}
          <FoldButton
            label={copy.subCalls}
            collapsed={false}
            expandLabel={copy.expandSubCalls}
            collapseLabel={copy.collapseSubCalls}
            onClick={() => undefined}
            disabled
          />
        </div>
        <label className="ml-auto flex h-[22px] min-w-[84px] flex-[0_1_164px] items-center gap-1 rounded-[5px] border-[0.5px] border-gray-a6 bg-dls-surface-muted px-1.5 text-gray-9 hover:border-gray-9 focus-within:border-blue-9 focus-within:bg-dls-surface">
          <Search size={11} className="flex-none" aria-hidden="true" />
          <input
            type="search"
            aria-label={copy.search}
            placeholder={copy.searchPlaceholder}
            value={props.searchQuery}
            onChange={(event) => props.onSearchQueryChange(event.currentTarget.value)}
            className="w-full min-w-0 border-0 bg-transparent p-0 text-[12px] leading-4 text-dls-text outline-0 placeholder:text-gray-9"
          />
        </label>
      </div>
    </div>
  );
}

function FoldButton(props: {
  label: string;
  collapsed: boolean;
  expandLabel: string;
  collapseLabel: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const action = props.collapsed ? props.expandLabel : props.collapseLabel;
  return (
    <button
      type="button"
      className={actionClass}
      aria-label={action}
      aria-pressed={props.collapsed}
      title={action}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span className="font-mono text-[14px] leading-[14px] text-gray-10" aria-hidden="true">
        {props.collapsed ? "⊞" : "⊟"}
      </span>
      {props.label}
    </button>
  );
}
