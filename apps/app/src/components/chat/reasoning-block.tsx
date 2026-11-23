"use client"

import { useState } from "react"
import { ChevronDown } from "lucide-react"

import { PixelLoader } from "@/components/chat/pixel-loader"
import { MessageContent } from "@/components/ui/message"
import { cn } from "@/lib/utils"

type ReasoningBlockProps = {
  text: string
  isStreaming: boolean
  className?: string
}

const HEADING = /^(?:#{1,6} +([^\n]+)|\*\*([^\n]+?)\*\*|__([^\n]+?)__)(?:\r?\n|$)/
const EASE = "cubic-bezier(0.23, 1, 0.32, 1)"

/**
 * Models often open a thought with a heading ("**Planning the fix**"). That
 * heading names the thought; the rest is its body. Without one, the thought
 * is just "Thinking" while live and "Thought" once done.
 */
export function reasoningPresentation(text: string, isStreaming: boolean): { title: string; body: string } {
  const trimmed = text.trim()
  const heading = HEADING.exec(trimmed)
  if (!heading) return { title: isStreaming ? "Thinking" : "Thought", body: trimmed }
  const title = (heading[1] ?? heading[2] ?? heading[3] ?? "").replace(/ +#+$/, "").trim()
  return { title, body: trimmed.slice(heading[0].length).trim() }
}

function Sparkle({ live }: { live: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      className={cn("shrink-0 transition-colors duration-200", live ? "text-muted-foreground" : "text-muted-foreground/70")}
      fill="currentColor"
    >
      <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
    </svg>
  )
}

/**
 * An expandable thinking trace (beautifului.dev "Thinking", MIT). It opens on
 * its own while the model thinks, folds away once the thought settles, and
 * stays expandable; the body hangs off a thin timeline rule.
 */
export function ReasoningBlock({ text, isStreaming, className }: ReasoningBlockProps) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)
  const { title, body } = reasoningPresentation(text, isStreaming)
  const open = Boolean(body) && (manualOpen ?? isStreaming)

  return (
    <div className={cn("flex w-full flex-col", className)} data-reasoning-block="">
      <button
        type="button"
        aria-expanded={open}
        disabled={!body}
        onClick={() => setManualOpen(!open)}
        className="-mx-1.5 flex w-fit max-w-full items-center gap-2 rounded-md px-1.5 py-1 text-start transition-colors duration-100 enabled:hover:bg-dls-hover disabled:cursor-default"
      >
        {isStreaming ? <PixelLoader className="mx-[1px] text-muted-foreground" /> : <Sparkle live={false} />}
        <span
          role="status"
          className={cn(
            "min-w-0 truncate text-sm font-medium",
            isStreaming ? "ow-text-shimmer" : "ow-fade-in text-muted-foreground",
          )}
        >
          {title}
        </span>
        {body ? (
          <ChevronDown
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-300"
            style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
          />
        ) : null}
      </button>

      <div
        className="grid transition-[grid-template-rows,opacity] duration-400"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0, transitionTimingFunction: EASE }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="relative mt-1 ml-[5px] pl-4">
            <span aria-hidden="true" className="absolute top-0 bottom-1 left-[3px] w-px bg-dls-border" />
            {open || isStreaming ? (
              <MessageContent
                markdown
                isStreaming={isStreaming}
                className="prose w-full min-w-0 bg-transparent p-0 py-1 text-sm leading-relaxed text-muted-foreground"
              >
                {body}
              </MessageContent>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
