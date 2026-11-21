import { useCallback, useEffect, useMemo, useState } from "react";

import type { OfflineGptSessionMessage } from "@/app/lib/offlinegpt-server";

/** Matches the session snapshot page the chat surface already loads. */
export const TRAJECTORY_HISTORY_PAGE = 140;

/**
 * Trajectory history: the live snapshot plus any earlier pages the user asked
 * for. Live messages win, so streaming updates keep flowing into the ledger.
 */
export function useTrajectoryHistory(options: {
  sessionId: string;
  messages: readonly OfflineGptSessionMessage[];
  loadPage: (limit: number) => Promise<readonly OfflineGptSessionMessage[]>;
}) {
  const { sessionId, messages, loadPage } = options;
  const [limit, setLimit] = useState(TRAJECTORY_HISTORY_PAGE);
  const [earlier, setEarlier] = useState<readonly OfflineGptSessionMessage[]>([]);
  useEffect(() => {
    setLimit(TRAJECTORY_HISTORY_PAGE);
    setEarlier([]);
  }, [sessionId]);

  const merged = useMemo(() => {
    if (earlier.length === 0) return messages;
    const live = new Set(messages.map((message) => message.info.id));
    return [...earlier.filter((message) => !live.has(message.info.id)), ...messages];
  }, [earlier, messages]);

  const loadEarlier = useCallback(async () => {
    const next = limit + TRAJECTORY_HISTORY_PAGE;
    const page = await loadPage(next);
    setEarlier(page);
    setLimit(next);
    return page.length >= next;
  }, [limit, loadPage]);

  return { messages: merged, hasEarlierRecords: merged.length >= limit, loadEarlier };
}
