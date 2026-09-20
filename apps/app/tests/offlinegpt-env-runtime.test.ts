import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  buildOfflineGptEnvRuntimeKey,
  readOfflineGptEnvPendingChanges,
  writeOfflineGptEnvPendingChanges,
} from "../src/app/lib/offlinegpt-env-runtime";

const originalWindow = globalThis.window;

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

describe("offlinegpt env runtime", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: memoryStorage(),
        sessionStorage: memoryStorage(),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  test("persists pending changes across browser sessions", () => {
    const runtimeKey = "http://127.0.0.1:8787::pid:123";
    writeOfflineGptEnvPendingChanges(true, runtimeKey);
    expect(readOfflineGptEnvPendingChanges(runtimeKey)).toBe(true);

    window.sessionStorage.clear();
    expect(readOfflineGptEnvPendingChanges(runtimeKey)).toBe(true);

    writeOfflineGptEnvPendingChanges(false);
    expect(readOfflineGptEnvPendingChanges(runtimeKey)).toBe(false);
  });

  test("reads legacy sessionStorage pending state", () => {
    window.sessionStorage.setItem("offlinegpt.settings.environment.pendingChanges", "1");

    expect(readOfflineGptEnvPendingChanges()).toBe(true);
  });

  test("clears pending changes after the runtime changes", () => {
    writeOfflineGptEnvPendingChanges(true, "http://127.0.0.1:8787::pid:123");

    expect(readOfflineGptEnvPendingChanges("http://127.0.0.1:8787::pid:456")).toBe(false);
    expect(readOfflineGptEnvPendingChanges("http://127.0.0.1:8787::pid:456")).toBe(false);
  });

  test("builds a stable runtime key from server identity", () => {
    expect(buildOfflineGptEnvRuntimeKey({
      baseUrl: "http://127.0.0.1:8787/",
      pid: 123,
      port: 8787,
    })).toBe("http://127.0.0.1:8787::pid:123");
    expect(buildOfflineGptEnvRuntimeKey({
      baseUrl: "http://127.0.0.1:8787",
      port: 8787,
    })).toBe("http://127.0.0.1:8787::port:8787");
    expect(buildOfflineGptEnvRuntimeKey({})).toBeUndefined();
  });
});
