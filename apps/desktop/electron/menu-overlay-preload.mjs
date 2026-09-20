import { contextBridge, ipcRenderer } from "electron";

let latestRequest = null;
let showCallback = null;

ipcRenderer.on("offlinegpt:menu-overlay:show", (_event, request) => {
  latestRequest = request;
  showCallback?.(request);
});

ipcRenderer.on("offlinegpt:menu-overlay:hide", () => {
  latestRequest = null;
  showCallback?.(null);
});

contextBridge.exposeInMainWorld("__OFFLINEGPT_MENU_OVERLAY__", {
  ready() {
    ipcRenderer.send("offlinegpt:menu-overlay:ready");
  },
  onShow(callback) {
    showCallback = callback;
    if (latestRequest) {
      callback(latestRequest);
    }
    return () => {
      if (showCallback === callback) {
        showCallback = null;
      }
    };
  },
  choose(requestId, itemId) {
    ipcRenderer.send("offlinegpt:menu-overlay:choose", { requestId, itemId });
  },
  close(requestId) {
    ipcRenderer.send("offlinegpt:menu-overlay:close", { requestId });
  },
});
