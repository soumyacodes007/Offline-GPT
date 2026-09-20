/** @jsxImportSource react */
import {
  createContext,
  use,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { OfflineGptServerStore } from "./offlinegpt-server-store";

const OfflineGptServerContext = createContext<OfflineGptServerStore | null>(null);

export function OfflineGptServerProvider(props: {
  store: OfflineGptServerStore;
  children: ReactNode;
}) {
  return (
    <OfflineGptServerContext.Provider value={props.store}>
      {props.children}
    </OfflineGptServerContext.Provider>
  );
}

export function useOfflineGptServer() {
  const store = use(OfflineGptServerContext);
  if (!store) {
    throw new Error("useOfflineGptServer must be used within an OfflineGptServerProvider");
  }

  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return store;
}
