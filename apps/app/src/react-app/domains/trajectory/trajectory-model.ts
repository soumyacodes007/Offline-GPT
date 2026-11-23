/**
 * Pure projection of an OpenCode session into the Trajectory ledger: turns
 * (one per user prompt) → Message / Step groups → records. Each `step-start`
 * segment of an assistant message is one model request ("Request #N").
 */
import type { AssistantMessage, Part, ToolPart } from "@opencode-ai/sdk/v2/client";

import type { OfflineGptSessionMessage } from "@/app/lib/offlinegpt-server";
import { stepLabel, trajectoryCopy } from "./trajectory-copy";

export type TrajectoryCellKind = "system" | "user" | "context" | "compacted" | "message" | "tool";
export type TrajectoryRecordState = "complete" | "running" | "error";

export type TrajectoryUsage = {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type TrajectoryAttachment = { name: string; mime: string };

export type TrajectoryCell = {
  /** Ledger order across the whole session. */
  index: number;
  id: string;
  kind: TrajectoryCellKind;
  turn: number | null;
  group: string;
  /** Request number for ASSISTANT records. */
  request?: number;
  /** One-line ledger preview. */
  text: string;
  /** Full markdown/text body for Preview. */
  body?: string;
  reasoning?: string;
  state: TrajectoryRecordState;
  startedAt: number | null;
  durationMs: number | null;
  firstTokenAt?: number | null;
  completedAt?: number | null;
  attachments?: TrajectoryAttachment[];
  toolName?: string;
  toolTitle?: string;
  input?: unknown;
  output?: string;
  error?: string;
  /** Call ids emitted by an ASSISTANT record, in order. */
  toolCallIds?: string[];
  callId?: string;
  agent?: string;
  /** Original OpenCode payload for the Raw tab. */
  raw: unknown;
};

export type TrajectoryGroup = { title: string; cells: TrajectoryCell[] };
export type TrajectoryTurn = { turn: number | null; groups: TrajectoryGroup[] };

export type TrajectoryRequest = {
  number: number;
  turn: number;
  step: number;
  group: string;
  cellIndex: number;
  status: TrajectoryRecordState;
  provider?: string;
  model?: string;
  agent?: string;
  startedAt: number | null;
  firstTokenAt: number | null;
  completedAt: number | null;
  toolCalls: number;
  cost?: number;
  finish?: string;
  retries: number;
  error?: string;
  usage?: TrajectoryUsage;
  cumulativeUsage?: TrajectoryUsage;
};

export type TrajectoryProjection = {
  turns: TrajectoryTurn[];
  cells: TrajectoryCell[];
  requests: TrajectoryRequest[];
};

type Segment = { parts: Part[]; first: boolean; last: boolean };

function finite(value: number | undefined | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function errorText(error: AssistantMessage["error"]): string | undefined {
  if (!error) return undefined;
  const message = "message" in error.data ? error.data.message : undefined;
  return typeof message === "string" && message ? `${error.name}: ${message}` : error.name;
}

function addUsage(total: TrajectoryUsage | undefined, usage: TrajectoryUsage | undefined): TrajectoryUsage | undefined {
  if (!usage) return total;
  const sum = (left?: number, right?: number) => left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
  return {
    input: sum(total?.input, usage.input),
    output: sum(total?.output, usage.output),
    reasoning: sum(total?.reasoning, usage.reasoning),
    cacheRead: sum(total?.cacheRead, usage.cacheRead),
    cacheWrite: sum(total?.cacheWrite, usage.cacheWrite),
  };
}

function usageOf(tokens: AssistantMessage["tokens"]): TrajectoryUsage {
  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cacheRead: tokens.cache.read,
    cacheWrite: tokens.cache.write,
  };
}

/** Split an assistant message into model requests at each `step-start`. */
function segments(parts: Part[]): Segment[] {
  const groups: Part[][] = [];
  for (const part of parts) {
    if (part.type === "step-start" || groups.length === 0) groups.push([]);
    groups[groups.length - 1].push(part);
  }
  if (groups.length === 0) groups.push([]);
  return groups.map((group, index) => ({ parts: group, first: index === 0, last: index === groups.length - 1 }));
}

function toolState(part: ToolPart): TrajectoryRecordState {
  if (part.state.status === "error") return "error";
  if (part.state.status === "completed") return "complete";
  return "running";
}

function toolTimes(part: ToolPart): { start: number | null; end: number | null } {
  if (part.state.status === "pending") return { start: null, end: null };
  if (part.state.status === "running") return { start: part.state.time.start, end: null };
  return { start: part.state.time.start, end: part.state.time.end };
}

/**
 * Project the resident OpenCode messages into Trajectory turns and requests.
 * @param messages - session messages in log order.
 * @param busy - whether the session is still running; open records stay pending.
 */
export function projectTrajectory(messages: readonly OfflineGptSessionMessage[], busy: boolean): TrajectoryProjection {
  const turns: TrajectoryTurn[] = [];
  const cells: TrajectoryCell[] = [];
  const requests: TrajectoryRequest[] = [];
  const stepsByTurn = new Map<number, number>();
  let turn = 0;
  let previousSystem: string | undefined;
  let cumulativeUsage: TrajectoryUsage | undefined;

  const currentTurn = (): TrajectoryTurn => {
    const last = turns.at(-1);
    if (last && last.turn === turn) return last;
    const created: TrajectoryTurn = { turn, groups: [] };
    turns.push(created);
    return created;
  };
  const push = (group: string, cell: Omit<TrajectoryCell, "index" | "turn" | "group">) => {
    const owner = currentTurn();
    let target = owner.groups.find((candidate) => candidate.title === group);
    if (!target) {
      target = { title: group, cells: [] };
      owner.groups.push(target);
    }
    const full: TrajectoryCell = { ...cell, index: cells.length, turn, group };
    target.cells.push(full);
    cells.push(full);
    return full;
  };

  for (const message of messages) {
    const info = message.info;
    if (info.role === "user") {
      turn += 1;
      const group = "Message";
      if (info.system && info.system !== previousSystem) {
        push(group, {
          id: `system:${info.id}`,
          kind: "system",
          text: previousSystem === undefined ? trajectoryCopy.layout.initialSystemPrompt : trajectoryCopy.layout.systemPromptUpdated,
          body: info.system,
          state: "complete",
          startedAt: info.time.created,
          durationMs: 0,
          raw: { system: info.system },
        });
        previousSystem = info.system;
      }
      const prompt: string[] = [];
      const attachments: TrajectoryAttachment[] = [];
      for (const part of message.parts) {
        if (part.type === "text" && !part.synthetic && !part.ignored) prompt.push(part.text);
        if (part.type === "file") attachments.push({ name: part.filename ?? part.url.split("/").pop() ?? part.url, mime: part.mime });
      }
      const body = prompt.join("\n\n");
      const attachmentSummary = attachments.length ? `Files ×${attachments.length}` : "";
      push(group, {
        id: `user:${info.id}`,
        kind: "user",
        text: oneLine(body) || attachmentSummary,
        body,
        attachments,
        state: "complete",
        startedAt: info.time.created,
        durationMs: 0,
        agent: info.agent,
        raw: message,
      });
      for (const part of message.parts) {
        const context = part.type === "text" && part.synthetic
          ? part.text
          : part.type === "agent"
            ? `Agent: @${part.name}`
            : part.type === "subtask"
              ? `Subtask (${part.agent}): ${part.description}`
              : null;
        if (context === null) continue;
        push(group, {
          id: `context:${part.id}`,
          kind: "context",
          text: oneLine(context),
          body: context,
          state: "complete",
          startedAt: info.time.created,
          durationMs: 0,
          raw: part,
        });
      }
      continue;
    }

    if (turn === 0) turn = 1;
    const messageError = errorText(info.error);
    const messageDone = finite(info.time.completed) || !busy || Boolean(info.error);
    const parts = segments(message.parts);
    let segmentStart: number | null = info.time.created;
    for (const segment of parts) {
      const compaction = segment.parts.find((part) => part.type === "compaction");
      if (compaction && compaction.type === "compaction") {
        push(stepLabel(Math.max(1, stepsByTurn.get(turn) ?? 1)), {
          id: `compaction:${compaction.id}`,
          kind: "compacted",
          text: messageDone ? trajectoryCopy.layout.compacted : trajectoryCopy.layout.compacting,
          body: segment.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n\n"),
          state: messageError ? "error" : messageDone ? "complete" : "running",
          startedAt: info.time.created,
          durationMs: finite(info.time.completed) ? info.time.completed - info.time.created : null,
          raw: message,
        });
        continue;
      }
      const step = (stepsByTurn.get(turn) ?? 0) + 1;
      stepsByTurn.set(turn, step);
      const group = stepLabel(step);
      const text: string[] = [];
      const reasoning: string[] = [];
      const tools: ToolPart[] = [];
      const outputTimes: number[] = [];
      const outputEnds: number[] = [];
      let finish: Extract<Part, { type: "step-finish" }> | undefined;
      let retries = 0;
      let retryError: string | undefined;
      for (const part of segment.parts) {
        if (part.type === "text" && !part.synthetic) {
          text.push(part.text);
          if (part.time) {
            outputTimes.push(part.time.start);
            if (finite(part.time.end)) outputEnds.push(part.time.end);
          }
        }
        if (part.type === "reasoning") {
          reasoning.push(part.text);
          outputTimes.push(part.time.start);
          if (finite(part.time.end)) outputEnds.push(part.time.end);
        }
        if (part.type === "tool") {
          tools.push(part);
          const times = toolTimes(part);
          if (times.start !== null) {
            outputTimes.push(times.start);
            outputEnds.push(times.start);
          }
        }
        if (part.type === "step-finish") finish = part;
        if (part.type === "retry") {
          retries += 1;
          retryError = part.error.data.message;
        }
      }
      const finished = Boolean(finish) || (segment.last && messageDone);
      const firstTokenAt = outputTimes.length ? Math.min(...outputTimes) : null;
      const completedAt = finished
        ? outputEnds.length ? Math.max(...outputEnds) : segment.last && finite(info.time.completed) ? info.time.completed : null
        : null;
      const startedAt = segmentStart ?? firstTokenAt;
      const error = segment.last ? messageError : undefined;
      const state: TrajectoryRecordState = error ? "error" : finished ? "complete" : "running";
      // The OpenCode v2 adapter creates streamed assistant messages before the engine reports usage.
      const usage = finish ? usageOf(finish.tokens) : parts.length === 1 && finished && info.tokens ? usageOf(info.tokens) : undefined;
      cumulativeUsage = addUsage(cumulativeUsage, usage);
      const body = text.join("\n\n");
      const number = requests.length + 1;
      const assistant = push(group, {
        id: `assistant:${info.id}:${step}`,
        kind: "message",
        request: number,
        text: oneLine(body) || (tools.length ? trajectoryCopy.record.toolCallOnly : error ?? ""),
        body,
        reasoning: reasoning.join("\n\n") || undefined,
        state,
        startedAt,
        durationMs: startedAt !== null && completedAt !== null ? Math.max(0, completedAt - startedAt) : null,
        firstTokenAt,
        completedAt,
        toolCallIds: tools.map((tool) => tool.callID),
        error,
        agent: info.agent,
        raw: { info, parts: segment.parts },
      });
      requests.push({
        number,
        turn,
        step,
        group,
        cellIndex: assistant.index,
        status: state,
        provider: info.providerID,
        model: info.modelID,
        agent: info.agent,
        startedAt,
        firstTokenAt,
        completedAt,
        toolCalls: tools.length,
        cost: finish?.cost ?? (parts.length === 1 ? info.cost : undefined),
        finish: finish?.reason ?? (segment.last ? info.finish : undefined),
        retries,
        error: error ?? retryError,
        usage,
        cumulativeUsage,
      });
      let toolsEnd: number | null = completedAt;
      for (const tool of tools) {
        const times = toolTimes(tool);
        const state = tool.state;
        const output = state.status === "completed" ? state.output : undefined;
        // A call still open after the session went idle was interrupted.
        const interrupted = toolState(tool) === "running" && !busy;
        const failure = state.status === "error" ? state.error : interrupted ? "Interrupted" : undefined;
        const result = failure ?? output;
        const inputText = stringify(state.input);
        push(group, {
          id: `tool:${tool.callID}`,
          kind: "tool",
          callId: tool.callID,
          toolName: tool.tool,
          toolTitle: state.status === "completed" || state.status === "running" ? state.title : undefined,
          text: `${tool.tool} ${oneLine(inputText)}`,
          input: state.input,
          output: result,
          error: failure,
          state: interrupted ? "error" : toolState(tool),
          startedAt: times.start,
          durationMs: times.start !== null && times.end !== null ? Math.max(0, times.end - times.start) : null,
          attachments: state.status === "completed"
            ? state.attachments?.map((file) => ({ name: file.filename ?? file.url, mime: file.mime }))
            : undefined,
          raw: tool,
        });
        if (times.end !== null) toolsEnd = Math.max(toolsEnd ?? times.end, times.end);
      }
      segmentStart = toolsEnd;
    }
  }

  return { turns, cells, requests };
}

/** One-line inline result for TOOL rows: `request → result`. */
export function toolResultPreview(cell: TrajectoryCell): string | undefined {
  if (cell.kind !== "tool") return undefined;
  if (cell.state === "running") return trajectoryCopy.record.running;
  const text = cell.output === undefined ? "" : oneLine(cell.output);
  return text || trajectoryCopy.record.noOutput;
}

/** Lowercased haystack for ledger search. */
export function trajectorySearchText(cell: TrajectoryCell): string {
  return [cell.text, cell.body, cell.reasoning, cell.toolName, cell.output, cell.error, cell.input === undefined ? "" : stringify(cell.input)]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

export function stringifyPayload(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}
