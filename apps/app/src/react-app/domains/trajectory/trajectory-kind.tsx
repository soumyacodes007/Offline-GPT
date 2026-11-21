import type { ReactNode } from "react";
import { Info, Settings, Shrink, Sparkles, User, Wrench } from "lucide-react";

import type { TrajectoryCellKind } from "./trajectory-model";

/** DeepSeek's kind palette, on OfflineGPT's Radix scales. */
export const KIND_TAG_CLASS: Record<TrajectoryCellKind, string> = {
  system: "bg-gray-3 text-dls-secondary",
  user: "bg-blue-3 text-blue-11",
  context: "bg-green-3 text-green-11",
  compacted: "bg-gray-3 text-dls-secondary",
  message: "bg-violet-3 text-violet-11",
  tool: "bg-amber-3 text-amber-11",
};

export const KIND_ICON: Record<TrajectoryCellKind, ReactNode> = {
  system: <Settings size={13} />,
  user: <User size={13} />,
  context: <Info size={13} />,
  compacted: <Shrink size={13} />,
  message: <Sparkles size={13} />,
  tool: <Wrench size={13} />,
};
