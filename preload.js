// Intentionally minimal.
//
// This window loads the AgentScribe web app directly, so we expose NO
// privileged Node/Electron APIs to that remote content — contextIsolation is
// on and sandbox is enabled in main.js. Keeping the preload empty is the
// secure default; add a contextBridge.exposeInMainWorld() bridge here only if
// the web app ever needs to call into the desktop shell.
