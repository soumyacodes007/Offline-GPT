/** Conversation view ring: `Chat | Trajectory` tabs with a "More conversation views" overflow. */
import { useLayoutEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { trajectoryCopy } from "./trajectory-copy";
import type { ConversationViewId } from "./conversation-view-store";

export type ConversationViewTab = { id: ConversationViewId; label: string };

const TAB_GAP_PX = 32;
const MORE_WIDTH_PX = 22 + TAB_GAP_PX;

export type ConversationViewTabsProps = {
  views: readonly ConversationViewTab[];
  active: ConversationViewId;
  unpinned: readonly ConversationViewId[];
  onSelect: (view: ConversationViewId) => void;
  onPinnedChange: (view: ConversationViewId, pinned: boolean) => void;
};

/** Hidden when fewer than two views are available. */
export function ConversationViewTabs(props: ConversationViewTabsProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [fitCount, setFitCount] = useState<number>(props.views.length);
  // Chat is always pinned so there is a view to fall back to.
  const pinned = props.views.filter((view) => view.id === "chat" || !props.unpinned.includes(view.id));

  useLayoutEffect(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!row || !measure) return;
    const update = () => {
      const widths = [...measure.children].map((child) => child.getBoundingClientRect().width);
      const available = row.getBoundingClientRect().width - MORE_WIDTH_PX;
      let used = 0;
      let count = 0;
      for (const width of widths) {
        const next = used + (count > 0 ? TAB_GAP_PX : 0) + width;
        if (next > available && count > 0) break;
        used = next;
        count += 1;
      }
      setFitCount(count);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(row);
    return () => observer.disconnect();
  }, [pinned.length]);

  if (props.views.length < 2) return null;

  const visible = pinned.slice(0, fitCount);
  const visibleIds = new Set(visible.map((view) => view.id));
  const currentInMore = !visibleIds.has(props.active);

  return (
    <div
      ref={rowRef}
      data-conversation-tabs-row=""
      className="relative z-[1] box-border flex w-full min-w-0 flex-none items-start gap-x-5 border-b-[0.5px] border-dls-border pl-5 pt-2.5"
    >
      <div aria-hidden="true" ref={measureRef} className="pointer-events-none invisible absolute left-0 top-0 flex whitespace-nowrap">
        {pinned.map((view) => (
          <span key={view.id} className="px-0 text-[13px] font-medium leading-4"><span className="block max-w-[88px] truncate">{view.label}</span></span>
        ))}
      </div>
      <div role="tablist" data-conversation-tabs="" className="flex min-h-[25px] min-w-0 gap-8">
        {visible.map((view) => {
          const selected = view.id === props.active;
          return (
            <button
              key={view.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => props.onSelect(view.id)}
              className={[
                "relative -mx-2.5 -mt-2.5 box-border min-h-[35px] cursor-pointer border-0 bg-transparent px-2.5 pb-[9px] pt-2.5 text-[13px] font-medium leading-4",
                "after:absolute after:inset-x-2.5 after:-bottom-px after:h-0.5 after:rounded-[2px] after:content-['']",
                selected ? "text-blue-11 after:bg-blue-9" : "text-gray-10 after:bg-transparent hover:text-dls-text",
                "focus-visible:outline-1 focus-visible:outline-blue-9",
              ].join(" ")}
            >
              <span className="block max-w-[88px] truncate">{view.label}</span>
            </button>
          );
        })}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={trajectoryCopy.moreViews}
              title={trajectoryCopy.moreViews}
              className={`-mt-[3px] inline-flex size-[22px] flex-none cursor-pointer items-center justify-center rounded-[5px] border-0 bg-transparent p-0 hover:bg-dls-hover aria-expanded:bg-dls-hover ${currentInMore ? "text-blue-11" : "text-dls-secondary"}`}
            >
              <MoreHorizontal size={16} />
            </button>
          }
        />
        <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-24px)]">
          <DropdownMenuGroup>
            {props.views.map((view) => (
              <DropdownMenuItem key={view.id} onClick={() => props.onSelect(view.id)} className={view.id === props.active ? "text-blue-11" : undefined}>
                {view.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>{trajectoryCopy.pinView}</DropdownMenuLabel>
            {props.views.filter((view) => view.id !== "chat").map((view) => (
              <DropdownMenuCheckboxItem
                key={view.id}
                checked={!props.unpinned.includes(view.id)}
                onCheckedChange={(checked) => props.onPinnedChange(view.id, checked)}
              >
                {view.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
