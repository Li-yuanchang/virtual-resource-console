const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vrcDesktopUpdate", {
  getState: () => ipcRenderer.invoke("vrc:update:get-state"),
  check: () => ipcRenderer.invoke("vrc:update:check"),
  download: () => ipcRenderer.invoke("vrc:update:download"),
  install: () => ipcRenderer.invoke("vrc:update:install"),
  onState: (listener) => {
    if (typeof listener !== "function") return () => undefined;
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("vrc:update:state", handler);
    return () => ipcRenderer.removeListener("vrc:update:state", handler);
  },
});
