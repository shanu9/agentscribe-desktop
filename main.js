// AgentScribe desktop overlay — Electron main process.
//
// The whole point of this wrapper is ONE thing the browser can never do:
// exclude its window from screen capture at the OS level. A web page is always
// visible under "Share Entire Screen". A native window calling
// setContentProtection(true) is not — on Windows it sets
// WDA_EXCLUDEFROMCAPTURE, on macOS it sets NSWindowSharingNone. The window
// stays visible to YOU but is blank/absent in any capture: entire-screen
// share, Zoom/Meet/Teams, OS screenshots, and most recorders.

const {
  app,
  BrowserWindow,
  globalShortcut,
  session,
  desktopCapturer,
  screen,
} = require("electron");
const path = require("path");

// Defaults to the deployed production site so a downloaded/packaged app works
// out of the box. Override for local dev:
//   AGENTSCRIBE_URL=http://localhost:3000/scribe npm start
const APP_URL =
  process.env.AGENTSCRIBE_URL || "https://agentcoresystem.com/scribe";

const NUDGE = 40; // px the window moves per arrow-hotkey press

let win = null;
let opacity = 1;

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 420;
  const height = 600;

  win = new BrowserWindow({
    width,
    height,
    // Top-right of the work area by default.
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + 24,
    frame: false,
    backgroundColor: "#0a0a0a",
    alwaysOnTop: true,
    skipTaskbar: true, // stay out of the taskbar / app switcher
    resizable: true,
    hasShadow: false,
    fullscreenable: false,
    minWidth: 320,
    minHeight: 360,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // ── THE privacy guarantee ───────────────────────────────────────────────
  win.setContentProtection(true);

  // Float above fullscreen meeting windows and follow the user across spaces.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadURL(APP_URL);

  // Give the user a mouse-draggable strip (frameless windows can't be dragged
  // otherwise). Centered + thin so it doesn't sit on the app's header buttons.
  win.webContents.on("did-finish-load", () => {
    win.webContents
      .insertCSS(
        `.__as_drag{position:fixed;top:0;left:50%;transform:translateX(-50%);` +
          `width:140px;height:16px;border-radius:0 0 8px 8px;` +
          `background:rgba(255,255,255,0.08);-webkit-app-region:drag;` +
          `z-index:2147483647;}`
      )
      .catch(() => {});
    win.webContents
      .executeJavaScript(
        `if(!document.getElementById('__as_drag')){` +
          `var d=document.createElement('div');d.id='__as_drag';` +
          `d.className='__as_drag';document.body.appendChild(d);}`
      )
      .catch(() => {});
  });

  win.on("closed", () => {
    win = null;
  });
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
  // Toggle the overlay in/out of view (panic key).
  globalShortcut.register("CommandOrControl+Shift+\\", toggleVisibility);
  // Reposition without touching the mouse.
  globalShortcut.register("CommandOrControl+Shift+Up", () => move(0, -NUDGE));
  globalShortcut.register("CommandOrControl+Shift+Down", () => move(0, NUDGE));
  globalShortcut.register("CommandOrControl+Shift+Left", () => move(-NUDGE, 0));
  globalShortcut.register("CommandOrControl+Shift+Right", () => move(NUDGE, 0));
  // Dim / brighten.
  globalShortcut.register("CommandOrControl+Shift+[", () => adjustOpacity(-0.1));
  globalShortcut.register("CommandOrControl+Shift+]", () => adjustOpacity(0.1));
  // Quit.
  globalShortcut.register("CommandOrControl+Shift+Q", () => app.quit());
}

app.whenReady().then(() => {
  const ses = session.defaultSession;

  // Allow the web app's mic / media requests (needed for "Start mic").
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(
      permission === "media" ||
        permission === "audioCapture" ||
        permission === "mediaKeySystem"
    );
  });

  // Allow getDisplayMedia (the "Share tab audio" path) to resolve without a
  // flaky in-page picker — hand it the primary screen + loopback audio.
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

  createWindow();
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
