/** English copy and number/time formatting for the Trajectory view. */

export const trajectoryCopy = {
  view: "Trajectory",
  chat: "Chat",
  moreViews: "More conversation views",
  pinView: "Show in tab bar",
  toolbar: {
    aria: "Trajectory toolbar",
    duration: "Duration",
    useActualDuration: "Use actual duration",
    useEqualWidth: "Use equal-width operations",
    turns: "Turns",
    expandTurns: "Expand turns",
    collapseTurns: "Collapse turns",
    calls: "Calls",
    expandCalls: "Expand calls",
    collapseCalls: "Collapse calls",
    subCalls: "Subcalls",
    expandSubCalls: "Expand subcalls",
    collapseSubCalls: "Collapse subcalls",
    search: "Search trajectory",
    searchPlaceholder: "Search",
  },
  kind: {
    system: "SYSTEM",
    user: "USER",
    context: "CONTEXT",
    compacted: "COMPACTED",
    message: "ASSISTANT",
    tool: "TOOL",
  },
  lane: { input: "Input", model: "Model", tools: "Tools" },
  status: { failed: "Failed", pending: "Pending", completed: "Completed" },
  timeline: {
    aria: "Trajectory timeline",
    overviewAria: "Timeline overview; drag horizontally to focus events",
    noTimingData: "No timing data",
  },
  history: {
    loading: "Loading trajectory…",
    loadingEarlier: "Loading earlier history…",
    loadEarlier: "Load earlier history",
    clickToLoadEarlier: "Click to load earlier history",
  },
  record: {
    toolCallOnly: "(tool call only)",
    noContent: "No content",
    noPayload: "No payload captured",
    noOutput: "No output",
    thinking: "Thinking",
    running: "Running…",
  },
  tab: {
    summary: "Summary",
    preview: "Preview",
    raw: "Raw",
    payload: "Payload",
    result: "Result",
    timing: "Timing",
    usage: "Usage",
  },
  details: {
    event: "Event details",
    resize: "Resize event details",
    resizeTitle: "Drag to resize. Double-click to reset.",
    close: "Close details",
    status: "Status",
    provider: "Provider",
    model: "Model",
    toolCalls: "Tool calls",
    error: "Error",
    retry: "Retry",
    finish: "Finish reason",
    cost: "Cost",
    tool: "Tool",
    title: "Title",
    attachments: "Attachments",
    agent: "Agent",
  },
  timing: {
    notAvailable: "Not available",
    started: "Started",
    totalDuration: "Total duration",
    ttft: "TTFT",
    generation: "Generation",
    throughput: "Throughput",
    duration: "Duration",
    source: "Timing source",
    sessionTimestamps: "Session timestamps",
    sessionTimestampsRunning: "Session timestamps (running)",
    firstTokenUnavailable: "First token unavailable",
    usageUnavailable: "Usage unavailable",
    durationTooShort: "Duration too short",
    showLocalTime: "Show local time",
    showUnixTimestamp: "Show Unix timestamp",
  },
  usage: {
    notReported: "Usage not reported",
    input: "Input",
    cached: "Cached",
    cacheCreated: "Cache created",
    output: "Output",
    reasoning: "Reasoning",
    thisRequest: "This request",
    sessionCumulative: "Session cumulative",
  },
  layout: {
    initialSystemPrompt: "Initial System Prompt",
    systemPromptUpdated: "System Prompt Updated",
    compacted: "Context compacted",
    compacting: "Compacting context…",
  },
} as const;

export function turnLabel(turn: number | null): string {
  return turn === null ? "Between turns" : `Turn ${turn}`;
}

export function stepLabel(step: number): string {
  return `Step ${step}`;
}

export function requestLabel(request: number): string {
  return `Request #${request}`;
}

export function countLabel(count: number, one: string, other: string): string {
  return `${count} ${count === 1 ? one : other}`;
}

export function formatDurationMs(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;
}

export function formatTokens(value: number): string {
  return `${value.toLocaleString()} tok`;
}

export function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

export function formatStartedAt(timestamp: number): string {
  const date = new Date(timestamp);
  const two = (value: number) => String(value).padStart(2, "0");
  const three = (value: number) => String(value).padStart(3, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} `
    + `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${three(date.getMilliseconds())}`;
}
