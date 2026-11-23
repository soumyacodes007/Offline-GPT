import { useState, type ReactNode } from "react";
import type { DynamicToolUIPart } from "ai";
import { ChevronRight } from "lucide-react";
import { CapabilityCallLine, TechnicalDetailsPanel } from "./capability-call-line";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { getCapabilityCallSentence } from "@/lib/capability-call";
import type { CurrentToolLifecycle } from "@/lib/current-tool-lifecycle";
import { isToolPartInFlight } from "@/lib/tool-activity";
import { cn } from "@/lib/utils";
import { resolveConnectorToolIdentity, type ConnectorToolIdentity } from "@/react-app/domains/connections/connector-tool-identity";

/** One line naming what the step did, e.g. "Computer Use · Fetched window state, Clicked +2". */
function stepSummary(calls: DynamicToolUIPart[], inFlight: boolean): string {
  if (calls.length === 0) return inFlight ? "Running a step" : "Ran a step";
  const sentences = calls.map((call) => getCapabilityCallSentence(call, { includeQuery: false }));
  const services = [...new Set(sentences.flatMap((sentence) => (sentence.service ? [sentence.service] : [])))];
  // Sentences end with "· <service>"; the line names the service once instead.
  const action = (text: string, service: string | null) => (service ? text.replace(` · ${service}`, "") : text);
  const last = sentences.at(-1);
  const current = inFlight && last ? action(last.present, last.service) : undefined;
  const actions = current ? [current] : [...new Set(sentences.map((sentence) => action(sentence.past, sentence.service)))];
  const shown = `${actions.slice(0, 2).join(", ")}${actions.length > 2 ? ` +${actions.length - 2}` : ""}`;
  return services.length === 1 ? `${services[0]} · ${shown}` : shown;
}

export function CodeModeTool({ part, calls, lifecycle, connectors, attachments }: {
  part: DynamicToolUIPart;
  calls: DynamicToolUIPart[];
  lifecycle: CurrentToolLifecycle | null;
  connectors: ConnectorToolIdentity[];
  /** Screenshots the step returned, shown when the step is expanded. */
  attachments?: ReactNode[];
}) {
  const inFlight = isToolPartInFlight(part);
  const failed = part.state === "output-error" || calls.some(call => call.state === "output-error");
  // Finished steps fold to one line; running, waiting and failed steps stay open until the user decides.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? (inFlight || failed);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const status = inFlight
    ? lifecycle === "waiting" ? "Waiting for your action" : lifecycle === "running" ? "Running" : "Status unavailable"
    : failed ? "Failed" : null;
  return (
    <Collapsible open={open} onOpenChange={setUserOpen} data-code-mode-call={part.toolCallId}>
      <CollapsibleTrigger className="group flex min-w-0 max-w-full items-center gap-2 text-start text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight aria-hidden="true" className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="min-w-0 truncate">{stepSummary(calls, inFlight)}</span>
        {status ? <span className={cn("shrink-0 text-xs", failed && "text-destructive")}>{status}</span> : null}
        {!inFlight && calls.length > 1 ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">{calls.length} actions</span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-2 border-l border-border pl-3">
        {calls.map(call => (
          <CapabilityCallLine
            key={call.toolCallId}
            part={call}
            connector={resolveConnectorToolIdentity(call, connectors)}
            resultUnavailable={call.state === "output-available"}
            statusUnknown={isToolPartInFlight(call) && (!inFlight || lifecycle !== "running")}
          />
        ))}
        {attachments?.length ? <div className="flex flex-wrap gap-2">{attachments}</div> : null}
        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground">
            <ChevronRight aria-hidden="true" className={cn("size-3 transition-transform", detailsOpen && "rotate-90")} />
            Execution details
          </CollapsibleTrigger>
          <CollapsibleContent><TechnicalDetailsPanel part={part} /></CollapsibleContent>
        </Collapsible>
      </CollapsibleContent>
    </Collapsible>
  );
}
