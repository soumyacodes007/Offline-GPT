/** Ledger rows: flatten turns, then apply search filtering or fold summaries. */
import { countLabel } from "./trajectory-copy";
import type { TrajectoryCell, TrajectoryTurn } from "./trajectory-model";

export type TrajectoryRowSummaryKind = "turn" | "assistant";

export type TrajectoryRow = {
  key: string;
  cell: TrajectoryCell;
  turnStart: boolean;
  turnEnd: boolean;
  groupStart: boolean;
  summary?: string;
  summaryKind?: TrajectoryRowSummaryKind;
};

export function flattenTrajectory(turns: readonly TrajectoryTurn[]): TrajectoryRow[] {
  const rows: TrajectoryRow[] = [];
  for (const turn of turns) {
    const cells = turn.groups.flatMap((group) => group.cells);
    cells.forEach((cell, position) => rows.push({
      key: cell.id,
      cell,
      turnStart: position === 0,
      turnEnd: position === cells.length - 1,
      groupStart: position === 0 || cells[position - 1]?.group !== cell.group,
    }));
  }
  return rows;
}

/** Search keeps only matching rows and recomputes their boundaries. */
export function filterRows(rows: readonly TrajectoryRow[], matches: ReadonlySet<number>): TrajectoryRow[] {
  const filtered = rows.filter((row) => matches.has(row.cell.index)).map((row) => ({ ...row }));
  const startedTurns = new Set<number | null>();
  filtered.forEach((row, position) => {
    const previous = filtered[position - 1];
    const next = filtered[position + 1];
    row.groupStart = !previous || previous.cell.turn !== row.cell.turn || previous.cell.group !== row.cell.group;
    row.turnStart = !startedTurns.has(row.cell.turn);
    startedTurns.add(row.cell.turn);
    row.turnEnd = !next || next.cell.turn !== row.cell.turn;
  });
  return filtered;
}

function summarizeTurn(rows: readonly TrajectoryRow[]): string {
  const steps = new Set(rows.filter((row) => row.cell.kind === "message").map((row) => row.cell.group)).size;
  const calls = rows.filter((row) => row.cell.kind === "tool").length;
  return `${countLabel(steps, "step", "steps")} · ${countLabel(calls, "tool call", "tool calls")}`;
}

function summarizeCalls(rows: readonly TrajectoryRow[]): string {
  const names = [...new Set(rows.flatMap((row) => row.cell.toolName ? [row.cell.toolName] : []))];
  const summary = countLabel(rows.length, "tool call", "tool calls");
  return names.length ? `${summary} · ${names.join(", ")}` : summary;
}

/** Fold a turn down to its first record plus a `… N steps · M tool calls` row. */
export function collapseTurns(rows: readonly TrajectoryRow[], collapsed: ReadonlySet<number>): TrajectoryRow[] {
  if (collapsed.size === 0) return [...rows];
  const byTurn = new Map<number, TrajectoryRow[]>();
  for (const row of rows) {
    if (row.cell.turn === null) continue;
    byTurn.set(row.cell.turn, [...(byTurn.get(row.cell.turn) ?? []), row]);
  }
  return rows.flatMap((row) => {
    const turn = row.cell.turn;
    if (turn === null || !collapsed.has(turn)) return [row];
    const content = (byTurn.get(turn) ?? [row]).filter((candidate) => candidate.cell.kind !== "system");
    if (row.cell.kind === "system" || content.length <= 1) return [row];
    if (row.cell.index !== content[0].cell.index) return [];
    return [
      { ...row, turnEnd: false },
      { ...row, key: `${row.key}:turn-summary`, groupStart: false, turnStart: false, turnEnd: true, summary: summarizeTurn(content.slice(1)), summaryKind: "turn" },
    ];
  });
}

/** Tool rows directly following an ASSISTANT record. */
export function followingToolRows(rows: readonly TrajectoryRow[], at: number): TrajectoryRow[] {
  const calls: TrajectoryRow[] = [];
  for (let index = at + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.summary !== undefined || row.cell.kind !== "tool") break;
    calls.push(row);
  }
  return calls;
}

/** Fold the tool calls under each collapsed ASSISTANT record into one summary row. */
export function collapseCalls(rows: readonly TrajectoryRow[], collapsed: ReadonlySet<string>): TrajectoryRow[] {
  if (collapsed.size === 0) return [...rows];
  const out: TrajectoryRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    out.push(row);
    if (row.summary !== undefined || row.cell.kind !== "message" || !collapsed.has(row.cell.id)) continue;
    const calls = followingToolRows(rows, index);
    if (calls.length === 0) continue;
    out[out.length - 1] = { ...row, turnEnd: false };
    out.push({
      ...row,
      key: `${row.key}:calls-summary`,
      groupStart: false,
      turnStart: false,
      turnEnd: calls.at(-1)?.turnEnd ?? false,
      summary: summarizeCalls(calls),
      summaryKind: "assistant",
    });
    index += calls.length;
  }
  return out;
}
