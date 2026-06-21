// Minimal, safe bridge: expose ONLY window-control actions (no Node/filesystem)
// so the loaded web app can offer a close/minimize button. contextIsolation is
// on and sandbox is enabled in main.js, so this is the only surface exposed.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentscribe", {
  isDesktop: true,
  quit: () => ipcRenderer.send("as:quit"),
  minimize: () => ipcRenderer.send("as:minimize"),
});
