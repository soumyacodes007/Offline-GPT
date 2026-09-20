import { contextBridge, ipcRenderer, webUtils } from "electron";

const NATIVE_DEEP_LINK_EVENT = "offlinegpt:deep-link-native";
const NATIVE_MENU_OPEN_SETTINGS_EVENT = "offlinegpt:native-menu:open-settings";
const NATIVE_MENU_TOGGLE_SIDEBAR_EVENT = "offlinegpt:native-menu:toggle-sidebar";
const NATIVE_MENU_CHECK_UPDATES_EVENT = "offlinegpt:native-menu:check-updates";
const NATIVE_MENU_ZOOM_EVENT = "offlinegpt:native-menu:zoom";
const AUTOMATION_RUNNER_CREDENTIAL_REJECTED_EVENT = "offlinegpt:automation-runner:credential-rejected";

function normalizePlatform(value) {
  if (value === "darwin" || value === "linux") return value;
  if (value === "win32") return "windows";
  return "linux";
}

function applyShellDocumentMarkers() {
  try {
    const root = document?.documentElement;
    if (!root) return false;

    root.dataset.offlinegptShell = "electron";
    root.classList.add("offlinegpt-electron");
    if (process.platform === "darwin") {
      root.classList.add("offlinegpt-platform-mac");
    } else if (process.platform === "win32") {
      root.classList.add("offlinegpt-platform-windows");
    } else if (process.platform === "linux") {
      root.classList.add("offlinegpt-platform-linux");
    }
    return true;
  } catch {
    return false;
  }
}

function notifyMenuOverlayDismiss() {
  ipcRenderer.send("offlinegpt:menu-overlay:dismiss");
}

function installMenuOverlayDismissListeners() {
  try {
    const target = window;
    target.addEventListener("pointerdown", notifyMenuOverlayDismiss, { capture: true });
    target.addEventListener("wheel", notifyMenuOverlayDismiss, { capture: true, passive: true });
    target.addEventListener("keydown", notifyMenuOverlayDismiss, { capture: true });
    return true;
  } catch {
    return false;
  }
}

// Capture before message-bubble menus, but leave files, app routes, editable
// text, and ordinary clicks to their existing handlers.
window.addEventListener("contextmenu", (event) => {
  const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
  if (!anchor || anchor.isContentEditable || anchor.hasAttribute("download")) return;
  const href = anchor.getAttribute("href") ?? "";
  if (!/^(https?:)?\/\//i.test(href)) return;
  let url;
  try { url = new URL(anchor.href); } catch { return; }
  if (!["http:", "https:"].includes(url.protocol)) return;
  if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  ipcRenderer.send("offlinegpt:browser:linkContextMenu", {
    url: url.href,
    point: { x: event.clientX, y: event.clientY },
    sessionId: anchor.closest("[data-session-surface-id]")?.getAttribute("data-session-surface-id") ?? null,
  });
}, { capture: true });

let desktopBootstrap = null;
let desktopDistribution = null;
try {
  desktopBootstrap = ipcRenderer.sendSync("offlinegpt:desktop-bootstrap-sync");
  desktopDistribution = ipcRenderer.sendSync("offlinegpt:desktop-distribution-sync");
} catch {
  desktopBootstrap = null;
  desktopDistribution = null;
}

contextBridge.exposeInMainWorld("__OFFLINEGPT_ELECTRON__", {
  invokeDesktop(command, ...args) {
    return ipcRenderer.invoke("offlinegpt:desktop", command, ...args);
  },
  automationRunner: {
    onCredentialRejected(callback) {
      const handler = () => callback();
      ipcRenderer.on(AUTOMATION_RUNNER_CREDENTIAL_REJECTED_EVENT, handler);
      return () => ipcRenderer.removeListener(AUTOMATION_RUNNER_CREDENTIAL_REJECTED_EVENT, handler);
    },
  },
  fileSystem: {
    getPathForFile(file) {
      return webUtils.getPathForFile(file);
    },
  },
  shell: {
    openExternal(url) {
      return ipcRenderer.invoke("offlinegpt:shell:openExternal", url);
    },
    relaunch() {
      return ipcRenderer.invoke("offlinegpt:shell:relaunch");
    },
  },
  system: {
    getArchitectureInfo() {
      return ipcRenderer.invoke("offlinegpt:system:architecture");
    },
    getMicrophoneStatus() {
      return ipcRenderer.invoke("offlinegpt:system:microphoneStatus");
    },
    askMicrophoneAccess() {
      return ipcRenderer.invoke("offlinegpt:system:askMicrophoneAccess");
    },
  },
  migration: {
    readSnapshot() {
      return ipcRenderer.invoke("offlinegpt:migration:read");
    },
    ackSnapshot() {
      return ipcRenderer.invoke("offlinegpt:migration:ack");
    },
  },
  brandIcon: {
    apply(url) {
      return ipcRenderer.invoke("offlinegpt:desktop", "__applyBrandIcon", url ?? null);
    },
    getState() {
      return ipcRenderer.invoke("offlinegpt:desktop", "__getBrandIconState");
    },
  },
  dev: {
    evalRelaunch() {
      return ipcRenderer.invoke("offlinegpt:desktop", "__evalRelaunch");
    },
  },
  nuke: {
    preview(options) {
      return ipcRenderer.invoke("offlinegpt:desktop", "nukeOfflineGptAndOpencodeConfigPreview", options);
    },
    execute(options) {
      return ipcRenderer.invoke("offlinegpt:desktop", "nukeOfflineGptAndOpencodeConfigAndExit", options);
    },
  },
  updater: {
    getChannel() {
      return ipcRenderer.invoke("offlinegpt:updater:getChannel");
    },
    setChannel(channel) {
      return ipcRenderer.invoke("offlinegpt:updater:setChannel", channel);
    },
    check(channel, targetVersion) {
      return ipcRenderer.invoke("offlinegpt:updater:check", channel, targetVersion);
    },
    download() {
      return ipcRenderer.invoke("offlinegpt:updater:download");
    },
    installAndRestart() {
      return ipcRenderer.invoke("offlinegpt:updater:installAndRestart");
    },
    /** Subscribe to incremental download progress from electron-updater. */
    onDownloadProgress(callback) {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on("offlinegpt:updater:download-progress", handler);
      return () => {
        ipcRenderer.removeListener("offlinegpt:updater:download-progress", handler);
      };
    },
  },
  recovery: {
    recordHealthy() {
      return ipcRenderer.invoke("offlinegpt:recovery:recordHealthy");
    },
    list(policy) {
      return ipcRenderer.invoke("offlinegpt:recovery:list", policy);
    },
    restorePrevious() {
      return ipcRenderer.invoke("offlinegpt:recovery:restorePrevious");
    },
    use(id) {
      return ipcRenderer.invoke("offlinegpt:recovery:use", id);
    },
  },
  browser: {
    show(bounds, sessionId) { return ipcRenderer.invoke("offlinegpt:browser:show", bounds, sessionId); },
    hide() { return ipcRenderer.invoke("offlinegpt:browser:hide"); },
    openUrl(url, provider, options) { return ipcRenderer.invoke("offlinegpt:browser:openUrl", url, provider, options); },
    setVisibleSession(sessionId) { return ipcRenderer.invoke("offlinegpt:browser:setVisibleSession", sessionId); },
    navigate(url) { return ipcRenderer.invoke("offlinegpt:browser:navigate", url); },
    back() { return ipcRenderer.invoke("offlinegpt:browser:back"); },
    forward() { return ipcRenderer.invoke("offlinegpt:browser:forward"); },
    reload() { return ipcRenderer.invoke("offlinegpt:browser:reload"); },
    setBounds(bounds) { return ipcRenderer.invoke("offlinegpt:browser:bounds", bounds); },
    getState() { return ipcRenderer.invoke("offlinegpt:browser:state"); },
    createTab(url, sessionId) { return ipcRenderer.invoke("offlinegpt:browser:createTab", url, sessionId); },
    closeTab(tabId) { return ipcRenderer.invoke("offlinegpt:browser:closeTab", tabId); },
    suspendTab(tabId) { return ipcRenderer.invoke("offlinegpt:browser:suspendTab", tabId); },
    restoreTab(tabId, sessionId) { return ipcRenderer.invoke("offlinegpt:browser:restoreTab", tabId, sessionId); },
    releaseTab(tabId, sessionId) { return ipcRenderer.invoke("offlinegpt:browser:releaseTab", tabId, sessionId); },
    closeAllTabs() { return ipcRenderer.invoke("offlinegpt:browser:closeAllTabs"); },
    closeSessionTabs(sessionId) { return ipcRenderer.invoke("offlinegpt:browser:closeSessionTabs", sessionId); },
    selectTab(tabId) { return ipcRenderer.invoke("offlinegpt:browser:selectTab", tabId); },
    reorderTabs(tabIds) { return ipcRenderer.invoke("offlinegpt:browser:reorderTabs", tabIds); },
    approve(tabId, approvalId, allowed) { return ipcRenderer.invoke("offlinegpt:browser:approve", tabId, approvalId, allowed); },
    taskControl(tabId, action) { return ipcRenderer.invoke("offlinegpt:browser:taskControl", tabId, action); },
    listTabs() { return ipcRenderer.invoke("offlinegpt:browser:listTabs"); },
    listWebMcpTools(args) { return ipcRenderer.invoke("offlinegpt:browser:webmcpListTools", args); },
    executeWebMcpTool(args) { return ipcRenderer.invoke("offlinegpt:browser:webmcpExecuteTool", args); },
    setProxy(proxy) { return ipcRenderer.invoke("offlinegpt:browser:setProxy", proxy); },
    getProxy() { return ipcRenderer.invoke("offlinegpt:browser:getProxy"); },
    setControlEnabled(enabled) { return ipcRenderer.invoke("offlinegpt:browser:setControlEnabled", enabled); },
    showTabContextMenu(tabId, point) { return ipcRenderer.invoke("offlinegpt:browser:tabContextMenu", tabId, point); },
    destroy() { return ipcRenderer.invoke("offlinegpt:browser:destroy"); },
    onStateChange(callback) {
      const handler = (_event, state) => callback(state);
      ipcRenderer.on("offlinegpt:browser:state", handler);
      return () => ipcRenderer.removeListener("offlinegpt:browser:state", handler);
    },
    onPanelOpened(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("offlinegpt:browser:panel-opened", handler);
      return () => ipcRenderer.removeListener("offlinegpt:browser:panel-opened", handler);
    },
    onPanelClosed(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("offlinegpt:browser:panel-closed", handler);
      return () => ipcRenderer.removeListener("offlinegpt:browser:panel-closed", handler);
    },
  },
  browserLogins: {
    disableForManagedContext() { return ipcRenderer.invoke("offlinegpt:browser-logins:disableForManagedContext"); },
    sources() { return ipcRenderer.invoke("offlinegpt:browser-logins:sources"); },
    preview(request) { return ipcRenderer.invoke("offlinegpt:browser-logins:preview", request); },
    configure(request) { return ipcRenderer.invoke("offlinegpt:browser-logins:configure", request); },
    state() { return ipcRenderer.invoke("offlinegpt:browser-logins:state"); },
    syncNow() { return ipcRenderer.invoke("offlinegpt:browser-logins:syncNow"); },
    pause() { return ipcRenderer.invoke("offlinegpt:browser-logins:pause"); },
    resume() { return ipcRenderer.invoke("offlinegpt:browser-logins:resume"); },
    stopSite(site) { return ipcRenderer.invoke("offlinegpt:browser-logins:stopSite", site); },
    disconnect(request) { return ipcRenderer.invoke("offlinegpt:browser-logins:disconnect", request); },
    signedInSites() { return ipcRenderer.invoke("offlinegpt:browser-logins:signedIn"); },
    forgetSite(site) { return ipcRenderer.invoke("offlinegpt:browser-logins:forgetSite", site); },
    forgetAll() { return ipcRenderer.invoke("offlinegpt:browser-logins:forgetAll"); },
    ...(process.env.OFFLINEGPT_EVAL_BROWSER_LOGIN_SYNC === "1" ? {
      writeTestStore(request) { return ipcRenderer.invoke("offlinegpt:browser-logins:writeTestStore", request); },
      testWitnessUrl() { return ipcRenderer.invoke("offlinegpt:browser-logins:testWitnessUrl"); },
    } : {}),
  },
  terminal: {
    create(options) { return ipcRenderer.invoke("offlinegpt:terminal:create", options); },
    write(terminalId, data) { return ipcRenderer.invoke("offlinegpt:terminal:write", terminalId, data); },
    resize(terminalId, cols, rows) { return ipcRenderer.invoke("offlinegpt:terminal:resize", terminalId, cols, rows); },
    kill(terminalId) { return ipcRenderer.invoke("offlinegpt:terminal:kill", terminalId); },
    onData(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("offlinegpt:terminal:data", handler);
      return () => ipcRenderer.removeListener("offlinegpt:terminal:data", handler);
    },
    onExit(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("offlinegpt:terminal:exit", handler);
      return () => ipcRenderer.removeListener("offlinegpt:terminal:exit", handler);
    },
  },
  meta: {
    desktopBootstrap,
    distribution: desktopDistribution,
    initialDeepLinks: [],
    platform: normalizePlatform(process.platform),
    version: process.versions.electron,
    evalFatalBootstrapFailure: process.env.OFFLINEGPT_EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE ?? null,
  },
});

if (
  process.env.OFFLINEGPT_EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE
  && (process.env.OFFLINEGPT_EVAL_RECOVERY_CANDIDATES || process.env.OFFLINEGPT_EVAL_RECOVERY_RELEASES)
) {
  contextBridge.exposeInMainWorld("__offlinegptRecoveryControl", {
    snapshot() {
      return ipcRenderer.invoke("offlinegpt:recovery:evalSnapshot");
    },
    select(id) {
      return ipcRenderer.invoke("offlinegpt:recovery:use", id);
    },
  });
}

ipcRenderer.on(NATIVE_DEEP_LINK_EVENT, (_event, urls) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NATIVE_DEEP_LINK_EVENT, { detail: urls }));
});

ipcRenderer.on(NATIVE_MENU_OPEN_SETTINGS_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_OPEN_SETTINGS_EVENT));
});

ipcRenderer.on(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT));
});

ipcRenderer.on(NATIVE_MENU_CHECK_UPDATES_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_CHECK_UPDATES_EVENT));
});

ipcRenderer.on(NATIVE_MENU_ZOOM_EVENT, (_event, action) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NATIVE_MENU_ZOOM_EVENT, { detail: action }));
});

if (!applyShellDocumentMarkers() && typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", applyShellDocumentMarkers, { once: true });
}

if (!installMenuOverlayDismissListeners() && typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", installMenuOverlayDismissListeners, { once: true });
}
