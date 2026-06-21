// AgentScribe desktop overlay — Electron main process.
//
// The whole point of this wrapper is ONE thing the browser can never do:
// exclude its window from screen capture at the OS level. A web page is always
// visible under "Share Entire Screen". A native window calling
// setContentProtection(true) is not — on Windows it sets
// WDA_EXCLUDEFROMCAPTURE, on macOS it sets NSWindowSharingNone. The window
// stays visible to YOU but is blank/absent in any capture: entire-screen
// share, Zoom/Meet/Teams, OS screenshots, and most recorders. (So if it looks
// "black" in a screen share — that's the feature working, not a bug.)

const {
  app,
  BrowserWindow,
  globalShortcut,
  session,
  desktopCapturer,
  screen,
  shell,
  Menu,
  Tray,
  nativeImage,
  ipcMain,
} = require("electron");
const path = require("path");

// Open STRAIGHT into the live copilot (clean app chrome), not the marketing
// page. Override for local dev:
//   AGENTSCRIBE_URL=http://localhost:3000/scribe/live npm start
const APP_URL =
  process.env.AGENTSCRIBE_URL || "https://agentcoresystem.com/scribe/live";

const NUDGE = 40; // px the window moves per arrow-hotkey press

let win = null;
let tray = null;
let opacity = 1;

// ── Single-instance lock ────────────────────────────────────────────────────
// Without this, launching the app again opens a SECOND overlay (the stack of
// black boxes you saw). Instead, focus the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  main();
}

// Window controls still exposed (harmless) for any in-page use.
ipcMain.on("as:quit", () => app.quit());
ipcMain.on("as:minimize", () => win && win.minimize());

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 460;
  const height = 760;

  win = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + 24,
    // A REAL native title bar → a guaranteed, always-visible minimize/close.
    // (Frameless + injected controls was unreliable.)
    frame: true,
    title: "AgentScribe",
    backgroundColor: "#f8fafc",
    alwaysOnTop: true,
    skipTaskbar: false, // show in the taskbar so it's findable
    resizable: true,
    fullscreenable: false,
    minWidth: 360,
    minHeight: 420,
    show: false, // show once ready → no white/black flash
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // ── THE privacy guarantee ───────────────────────────────────────────────
  win.setContentProtection(true);
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.once("ready-to-show", () => win.show());

  win.loadURL(APP_URL).catch(() => showError());

  // If the page can't load (offline, server down), show a friendly retry
  // screen instead of a blank window.
  win.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3 /* not a user-abort */) showError(desc);
  });

  // New windows / target=_blank links (WhatsApp, guide, etc.) open in the real
  // browser instead of a stray Electron window. Full-page navigations are left
  // in-window so sign-in and the Razorpay payment→return flow work normally.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("closed", () => {
    win = null;
  });
}

// System tray — a production-grade, ALWAYS-available control surface. Even when
// the overlay is hidden (hotkey), always-on-top, or you can't find the window,
// the tray icon guarantees a way to Show/Hide and — most importantly — Quit.
function createTray() {
  if (tray) return;
  try {
    let img = nativeImage.createFromPath(path.join(__dirname, "build", "icon.png"));
    if (!img.isEmpty()) img = img.resize({ width: 18, height: 18 });
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip("AgentScribe");
    const menu = Menu.buildFromTemplate([
      {
        label: "Show / Hide AgentScribe",
        click: () => toggleVisibility(),
      },
      {
        label: "Reload",
        click: () => win && win.reload(),
      },
      { type: "separator" },
      {
        label: "Quit AgentScribe",
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
    // Left-click the tray → bring the overlay to front (Windows behaviour).
    tray.on("click", () => {
      if (!win) return;
      if (win.isVisible()) win.focus();
      else win.show();
    });
  } catch {
    /* tray is a safety net; never block startup if it fails */
  }
}

function showError(detail) {
  if (!win) return;
  const msg = detail ? String(detail).slice(0, 120) : "Couldn't reach AgentScribe.";
  const html =
    `<!doctype html><meta charset="utf-8"/>` +
    `<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;` +
    `font-family:-apple-system,system-ui,sans-serif;background:#f8fafc;color:#334155;text-align:center">` +
    `<div style="max-width:300px;padding:24px">` +
    `<div style="font-size:16px;font-weight:600;color:#0f172a">Can't connect</div>` +
    `<div style="margin-top:8px;font-size:13px;color:#64748b">${msg}<br/>Check your internet, then retry.</div>` +
    `<button onclick="location.href='${APP_URL}'" style="margin-top:16px;border:none;border-radius:999px;` +
    `background:#10b981;color:#04201a;font-weight:600;padding:10px 20px;font-size:13px;cursor:pointer">Retry</button>` +
    `</div></body>`;
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html)).catch(() => {});
}

function move(dx, dy) {
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(x + dx, y + dy);
}

function adjustOpacity(delta) {
  if (!win) return;
  opacity = Math.min(1, Math.max(0.2, Math.round((opacity + delta) * 10) / 10));
  win.setOpacity(opacity);
}

function toggleVisibility() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else win.show();
}

function registerShortcuts() {
  globalShortcut.register("CommandOrControl+Shift+\\", toggleVisibility);
  globalShortcut.register("CommandOrControl+Shift+Up", () => move(0, -NUDGE));
  globalShortcut.register("CommandOrControl+Shift+Down", () => move(0, NUDGE));
  globalShortcut.register("CommandOrControl+Shift+Left", () => move(-NUDGE, 0));
  globalShortcut.register("CommandOrControl+Shift+Right", () => move(NUDGE, 0));
  globalShortcut.register("CommandOrControl+Shift+[", () => adjustOpacity(-0.1));
  globalShortcut.register("CommandOrControl+Shift+]", () => adjustOpacity(0.1));
  globalShortcut.register("CommandOrControl+Shift+Q", () => app.quit());
}

// A minimal app menu so standard Copy/Paste/Select-All shortcuts work in the
// inputs, plus a visible Quit and the hotkey reference.
function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Show / Hide overlay", accelerator: "CommandOrControl+Shift+\\", click: toggleVisibility },
        { label: "Reload", accelerator: "CommandOrControl+R", click: () => win && win.reload() },
        { type: "separator" },
        { label: "Quit AgentScribe", accelerator: "CommandOrControl+Shift+Q", click: () => app.quit() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function main() {
  app.whenReady().then(() => {
    const ses = session.defaultSession;

    // Allow the web app's mic / media requests (needed for "Start mic").
    // getUserMedia passes through TWO gates in Electron: the async REQUEST
    // handler (prompt) AND a synchronous CHECK handler. If the check handler is
    // missing, Electron can deny the mic even though the request handler allows
    // it — which surfaced as "microphone not found / permission" INSIDE the app
    // even after the user granted access. Both must say yes.
    const allowMedia = (permission) =>
      permission === "media" ||
      permission === "audioCapture" ||
      permission === "microphone" ||
      permission === "mediaKeySystem";

    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(allowMedia(permission));
    });
    if (typeof ses.setPermissionCheckHandler === "function") {
      ses.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));
    }

    // Allow getDisplayMedia (the "Record screen share" path) to resolve with
    // the primary screen + loopback audio, no flaky in-page picker.
    if (typeof ses.setDisplayMediaRequestHandler === "function") {
      ses.setDisplayMediaRequestHandler((_request, callback) => {
        desktopCapturer
          .getSources({ types: ["screen"] })
          .then((sources) => {
            if (sources[0]) callback({ video: sources[0], audio: "loopback" });
            else callback({});
          })
          .catch(() => callback({}));
      });
    }

    buildMenu();
    createWindow();
    createTray();
    registerShortcuts();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
  });
}
