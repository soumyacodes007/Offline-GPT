import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ConversationViewId = "chat" | "trajectory";

type ConversationViewState = {
  /** Preferred view; resolves back to Chat when it is not registered. */
  preferredView: ConversationViewId;
  /** Views the user removed from the tab bar; they stay reachable from More. */
  unpinned: ConversationViewId[];
  trajectoryActualDuration: boolean;
  setPreferredView: (view: ConversationViewId) => void;
  setPinned: (view: ConversationViewId, pinned: boolean) => void;
  setTrajectoryActualDuration: (value: boolean) => void;
};

export const useConversationViewStore = create<ConversationViewState>()(persist(
  (set) => ({
    preferredView: "chat",
    unpinned: [],
    trajectoryActualDuration: false,
    setPreferredView: (preferredView) => set({ preferredView }),
    setPinned: (view, pinned) => set((state) => ({
      unpinned: pinned ? state.unpinned.filter((id) => id !== view) : [...new Set([...state.unpinned, view])],
    })),
    setTrajectoryActualDuration: (trajectoryActualDuration) => set({ trajectoryActualDuration }),
  }),
  {
    name: "offlinegpt.conversation-views",
    partialize: (state) => ({
      preferredView: state.preferredView,
      unpinned: state.unpinned,
      trajectoryActualDuration: state.trajectoryActualDuration,
    }),
  },
));
