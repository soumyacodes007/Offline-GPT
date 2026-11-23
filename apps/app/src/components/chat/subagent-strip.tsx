"use client"

import { useEffect, useState } from "react"
import { ArrowUpRight, Bot, ChevronRight, ShieldAlert } from "lucide-react"

import { taskChildSessionId, type TaskToolPart } from "@/lib/build-in-tools"
import { formatElapsedSeconds, getToolCallStartedAt } from "@/lib/tool-call-duration"
import { cn } from "@/lib/utils"
import { useSessionActivityStore } from "@/react-app/domains/session/status/session-activity-store"

type SubagentStripProps = {
  /** Delegated tasks still running in this session. */
  tasks: TaskToolPart[]
  workspaceId: string
  onOpenSession?: (sessionId: string) => void
}

function agentName(slug: string): string {
  const words = slug.split(/[-_.\s]+/).filter(Boolean)
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ") || "Agent"
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [active])
  return now
}

/**
 * One line above the composer while sub-agents run: "2 sub-agents running,
 * 1 needs you". It opens into a row per sub-agent; each row opens that
 * sub-agent's chat. A sub-agent that needs an answer keeps the list open.
 */
export function SubagentStrip({ tasks, workspaceId, onOpenSession }: SubagentStripProps) {
  const [expanded, setExpanded] = useState(false)
  const now = useNow(tasks.length > 0)
  const waitingIds = useSessionActivityStore((state) => {
    const records = state.recordsByWorkspaceId[workspaceId]
    return tasks
      .map((part) => taskChildSessionId(part))
      .filter((id): id is string => {
        if (!id) return false
        const child = records?.[id]
        return (child?.waitingPermissionIds.length ?? 0) > 0 || (child?.waitingQuestionIds.length ?? 0) > 0
      })
      .join(",")
  })
  if (tasks.length === 0) return null

  const waiting = new Set(waitingIds ? waitingIds.split(",") : [])
  const running = tasks.length - waiting.size
  const summary = [
    running > 0 ? `${running} sub-agent${running === 1 ? "" : "s"} running` : "",
    waiting.size > 0 ? `${waiting.size} need${waiting.size === 1 ? "s" : ""} you` : "",
  ].filter(Boolean).join(", ")
  const open = expanded || tasks.length === 1 || waiting.size > 0

  return (
    <section data-subagent-strip="" className="mx-3 mb-1.5 overflow-hidden rounded-xl border border-dls-border bg-dls-surface text-sm">
      <button
        type="button"
        aria-expanded={open}
        disabled={tasks.length === 1 || waiting.size > 0}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-start text-muted-foreground transition-colors enabled:hover:text-foreground"
      >
        <Bot aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="ow-text-shimmer min-w-0 flex-1 truncate">{summary}</span>
        {tasks.length > 1 && waiting.size === 0 ? (
          <ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform duration-150", open && "rotate-90")} />
        ) : null}
      </button>
      {open ? (
        <ul className="flex flex-col border-t border-dls-border py-1">
          {tasks.map((part) => {
            const childId = taskChildSessionId(part)
            const needsYou = childId ? waiting.has(childId) : false
            const startedAt = getToolCallStartedAt(part)
            const title = part.input?.description?.trim().slice(0, 160) || "Sub-agent task"
            const row = (
              <>
                {needsYou ? (
                  <ShieldAlert aria-label="Needs you" className="size-3.5 shrink-0 text-amber-10" />
                ) : (
                  <span aria-hidden="true" className="size-1.5 shrink-0 animate-pulse rounded-full bg-dls-accent" />
                )}
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {title}
                  <span className="text-muted-foreground"> · {agentName(part.input?.subagent_type ?? "")}</span>
                </span>
                <span className={cn("shrink-0 tabular-nums text-xs", needsYou ? "font-medium text-amber-11" : "text-muted-foreground")}>
                  {needsYou ? "Needs you" : startedAt ? formatElapsedSeconds(Math.max(0, Math.floor((now - startedAt) / 1000))) : "Starting"}
                </span>
                {childId && onOpenSession ? (
                  <ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                ) : null}
              </>
            )
            return (
              <li key={part.toolCallId} data-subagent-strip-row={childId ?? part.toolCallId}>
                {childId && onOpenSession ? (
                  <button
                    type="button"
                    onClick={() => onOpenSession(childId)}
                    aria-label={`${title}. Open sub-agent chat`}
                    className="group flex w-full items-center gap-2 px-3 py-1.5 text-start transition-colors hover:bg-dls-hover"
                  >
                    {row}
                  </button>
                ) : (
                  <div className="flex items-center gap-2 px-3 py-1.5">{row}</div>
                )}
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
