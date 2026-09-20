declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toEqual: (expected: unknown) => void;
};

import {
  OFFLINEGPT_EXTENSION_CATALOG,
  filterOfflineGPTExtensionCatalogForPlatform,
  resolveOfflineGPTExtensionCatalogPlatform,
} from "./constants";

function filteredIds(platform: "darwin" | "linux" | "windows" | "web") {
  return filterOfflineGPTExtensionCatalogForPlatform(OFFLINEGPT_EXTENSION_CATALOG, platform)
    .flatMap((entry) => entry.id ? [entry.id] : []);
}

describe("OfflineGPT extension catalog platform filter", () => {
  test("resolves browser runtime to web and desktop runtime to OS", () => {
    expect(resolveOfflineGPTExtensionCatalogPlatform("web", "macos")).toEqual("web");
    expect(resolveOfflineGPTExtensionCatalogPlatform("desktop", "macos")).toEqual("darwin");
    expect(resolveOfflineGPTExtensionCatalogPlatform("desktop", "windows")).toEqual("windows");
    expect(resolveOfflineGPTExtensionCatalogPlatform("desktop", "linux")).toEqual("linux");
  });

  test("hides desktop-only extensions in web", () => {
    expect(filteredIds("web")).toEqual(["ollama"]);
  });

  test("keeps OfflineGPT Browser desktop-only and Computer Use mac-only", () => {
    expect(filteredIds("darwin")).toEqual(["offlinegpt-browser", "computer-use", "ollama"]);
    expect(filteredIds("linux")).toEqual(["offlinegpt-browser", "ollama"]);
  });
});
