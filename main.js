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
  Notification,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");

// Open STRAIGHT into the live copilot (clean app chrome), not the marketing
// page. Override for local dev:
//   AGENTSCRIBE_URL=http://localhost:3000/scribe/live npm start
const APP_URL =
  process.env.AGENTSCRIBE_URL || "https://agentcoresystem.com/scribe/live";
// Origin the overlay is allowed to stay on (navigation guard).
const APP_ORIGIN = (() => {
  try {
    return new URL(APP_URL).origin;
  } catch {
    return "https://agentcoresystem.com";
  }
})();
const APP_HOST = (() => {
  try {
    return new URL(APP_ORIGIN).hostname.toLowerCase();
  } catch {
    return "agentcoresystem.com";
  }
})();

const NUDGE = 40; // px the window moves per arrow-hotkey press

// ── Minimal file logging ─────────────────────────────────────────────────────
// A rolling log in userData so a user's "it broke" can actually be diagnosed
// (crashes, load failures, update errors). Best-effort — logging must never
// throw or block. Path is printed once so support can ask the user for it.
function logFile() {
  return path.join(app.getPath("userData"), "agentscribe.log");
}
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}\n`;
  try {
    fs.appendFileSync(logFile(), line);
  } catch {
    /* never block on logging */
  }
}

let win = null;
let tray = null;
let opacity = 1;
// Overlay transparency. This only changes what YOU see locally — the window is
// excluded from screen capture regardless of opacity, so lowering it never makes
// the overlay any more visible to a screen-share. Floor keeps it findable.
const OPACITY_MIN = 0.3;
const OPACITY_STEP = 0.1;
const OPACITY_PRESETS = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4];
let titleRevertTimer = null;
// "idle" | "checking" | "downloading" | "downloaded" | "error"
let updateState = "idle";

// ── Window-state persistence ────────────────────────────────────────────────
// Position/size/opacity are saved to userData so the overlay reopens exactly
// where the user left it (it used to reset to the top-right corner every
// launch, undoing their placement). Guarded everywhere: a corrupt or
// off-screen saved state must never strand the window where it can't be seen.
const STATE_FILE = () => path.join(app.getPath("userData"), "window-state.json");

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8"));
    if (s && typeof s === "object") return s;
  } catch {
    /* first run or corrupt file → defaults */
  }
  return null;
}

let saveTimer = null;
function saveState() {
  if (!win) return;
  // Debounce: move/resize fire rapidly; only the last state matters.
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!win) return;
      const [x, y] = win.getPosition();
      const [width, height] = win.getSize();
      fs.writeFileSync(
        STATE_FILE(),
        JSON.stringify({ x, y, width, height, opacity })
      );
    } catch {
      /* best-effort; never crash on a failed save */
    }
  }, 400);
}

// A saved rectangle is only usable if it still overlaps a CONNECTED display —
// otherwise a monitor that was unplugged since last run would place the window
// in dead space. Returns true when at least part of the rect is on some screen.
function isOnSomeDisplay(x, y, width, height) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return (
      x < a.x + a.width &&
      x + width > a.x &&
      y < a.y + a.height &&
      y + height > a.y
    );
  });
}

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
  const saved = loadState();
  const width = saved?.width ?? 460;
  const height = saved?.height ?? 760;
  // Restore the saved position only if it still lands on a connected display;
  // otherwise fall back to the default top-right corner.
  const useSaved =
    saved &&
    Number.isFinite(saved.x) &&
    Number.isFinite(saved.y) &&
    isOnSomeDisplay(saved.x, saved.y, width, height);
  const x = useSaved ? saved.x : workArea.x + workArea.width - width - 24;
  const y = useSaved ? saved.y : workArea.y + 24;
  // Restore saved opacity, but NEVER below the visible floor — a stale ultra-low
  // value (e.g. from the old 0.2 hotkey floor) must not reopen the window
  // invisible and look like "the app won't open".
  opacity =
    saved && Number.isFinite(saved.opacity)
      ? Math.min(1, Math.max(OPACITY_MIN, saved.opacity))
      : 1;

  win = new BrowserWindow({
    width,
    height,
    x,
    y,
    // A REAL native title bar → a guaranteed, always-visible minimize/close.
    // (Frameless + injected controls was unreliable.)
    frame: true,
    title: "AgentScribe",
    backgroundColor: "#f8fafc",
    alwaysOnTop: true,
    // Hidden from the taskbar/dock for a private, no-footprint overlay
    // (HuddleMate-style). The tray icon + the Ctrl/Cmd+Shift+\ panic hotkey
    // are the guaranteed ways to find and toggle it, so nothing is lost.
    skipTaskbar: true,
    resizable: true,
    fullscreenable: false,
    minWidth: 360,
    minHeight: 420,
    show: false, // shown immediately below with the loading splash
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Don't throttle the renderer when the overlay is hidden — it may be
      // recording in the background, and a throttled renderer can stall audio.
      backgroundThrottling: false,
    },
  });

  // ── THE privacy guarantee ───────────────────────────────────────────────
  win.setContentProtection(true);
  // Electron drops the WDA_EXCLUDEFROMCAPTURE affinity across a hide→show cycle,
  // after which the window is captured as an opaque BLACK rectangle (WDA_MONITOR)
  // instead of being absent — the exact "black box on screen-share" failure. Our
  // overlay hides to tray on close and toggles via the panic hotkey, so it WILL
  // be reshown. Re-assert protection on every show so it is re-excluded each time.
  // Ref: electron/electron#29085, #45990, PRs #45868/#47020.
  win.on("show", () => {
    if (win && !win.isDestroyed()) win.setContentProtection(true);
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (opacity !== 1) win.setOpacity(opacity);

  // Persist placement whenever the user moves or resizes the window.
  win.on("move", saveState);
  win.on("resize", saveState);

  // The X button HIDES to the tray instead of quitting — this is a background
  // overlay that should stay running between meetings, and a real tray app
  // never dies on close. A one-time notification tells the user where it went;
  // real quits (tray Quit / Ctrl+Shift+Q / before-quit) set app.isQuitting and
  // pass through.
  win.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
      notifyHiddenOnce();
    }
  });

  // Show INSTANTLY with a branded loading splash so launch never looks like
  // "nothing happened" on a cold/slow network. Swap to the web app when it has
  // painted (did-finish-load), or fall back to the error screen.
  win.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        `<!doctype html><meta charset="utf-8"/>` +
          `<body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;` +
          `font-family:-apple-system,system-ui,sans-serif;background:#f8fafc;color:#0f172a">` +
          `<div style="font-size:18px;font-weight:700;letter-spacing:-0.01em">AgentScribe</div>` +
          `<div style="margin-top:14px;width:22px;height:22px;border:3px solid #10b98133;border-top-color:#10b981;` +
          `border-radius:50%;animation:s .8s linear infinite"></div>` +
          `<div style="margin-top:14px;font-size:12px;color:#64748b">Loading…</div>` +
          `<style>@keyframes s{to{transform:rotate(360deg)}}</style></body>`
      )
  );
  win.once("ready-to-show", () => win.show());

  // Once the real app has loaded, replace the splash with it.
  win.webContents.once("did-finish-load", () => {
    win.loadURL(APP_URL).catch(() => showError());
  });

  // If the page can't load (offline, server down), show a friendly retry
  // screen instead of a blank window.
  win.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3 /* not a user-abort */) {
      log("did-fail-load", code, desc, url);
      showError(desc);
    }
  });

  // CRASH RECOVERY. A renderer crash otherwise leaves a frozen white window
  // with no way out. Recover: for a clean exit do nothing; for a real crash,
  // reload once (kills the frozen state) so the user isn't stuck.
  win.webContents.on("render-process-gone", (_e, details) => {
    log("render-process-gone", details && details.reason);
    if (details && (details.reason === "clean-exit" || details.reason === "killed")) return;
    try {
      win.webContents.reloadIgnoringCache();
    } catch {
      showError("The app hit a snag and is reloading.");
    }
  });

  // If the renderer hangs (rare), offer the retry screen rather than a beachball.
  win.webContents.on("unresponsive", () => {
    log("renderer unresponsive");
    showError("The app stopped responding.");
  });

  // New windows / target=_blank links (WhatsApp, guide, etc.) open in the real
  // browser instead of a stray Electron window. Full-page navigations are left
  // in-window so sign-in and the Razorpay payment→return flow work normally.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // NAVIGATION GUARD: keep the always-on-top, capture-protected overlay pinned
  // to our own origin. A redirect or stray link to a third-party site opens in
  // the real browser instead of loading inside the private window. The splash
  // data: URL and OAuth/payment providers we rely on are allowed through.
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("data:")) return;
    // Match on the parsed HOSTNAME (not a substring), so a hostile URL that
    // merely CONTAINS "razorpay.com" as a path/query can't slip through.
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      /* unparseable → treat as external */
    }
    const isAllowedHost = (h) =>
      h === APP_HOST ||
      h === "www." + APP_HOST ||
      h.endsWith(".supabase.co") ||
      h === "google.com" ||
      h.endsWith(".google.com") ||
      h === "razorpay.com" ||
      h.endsWith(".razorpay.com");
    if (host && isAllowedHost(host)) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });

  win.on("closed", () => {
    win = null;
  });
}

// System tray — a production-grade, ALWAYS-available control surface. Even when
// the overlay is hidden (hotkey), always-on-top, or you can't find the window,
// the tray icon guarantees a way to Show/Hide and — most importantly — Quit.
// Tray menu is rebuilt whenever the update state changes (so it can surface
// "Restart to update"), so the template lives in its own function.
function buildTrayMenu() {
  const items = [
    { label: "Show / Hide AgentScribe", click: () => toggleVisibility() },
    { label: "Home (Live)", click: () => goHome() },
    { label: "Back", click: () => goBack() },
    { label: "Reload", click: () => win && win.reload() },
    { label: "Transparency", submenu: transparencySubmenu() },
    { type: "separator" },
  ];
  if (updateState === "downloaded") {
    items.push({
      label: "Restart to update ✨",
      click: () => {
        app.isQuitting = true;
        autoUpdater.quitAndInstall();
      },
    });
  } else {
    items.push({
      label:
        updateState === "checking"
          ? "Checking for updates…"
          : updateState === "downloading"
            ? "Downloading update…"
            : "Check for updates",
      enabled: updateState === "idle" || updateState === "error",
      click: () => checkForUpdates(true),
    });
  }
  items.push(
    { type: "separator" },
    {
      label: "Quit AgentScribe",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    }
  );
  return Menu.buildFromTemplate(items);
}

function refreshTray() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  if (tray) return;
  try {
    let img = nativeImage.createFromPath(path.join(__dirname, "build", "icon.png"));
    if (!img.isEmpty()) img = img.resize({ width: 18, height: 18 });
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip("AgentScribe");
    tray.setContextMenu(buildTrayMenu());
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

// ── Auto-update ──────────────────────────────────────────────────────────────
// Background updates from GitHub Releases (the same target CI publishes to), so
// users never have to re-download. Downloads silently, installs on next quit;
// the tray surfaces "Restart to update" the moment a build is ready. Everything
// is best-effort — a failed/absent update must never disrupt a live meeting.
let updateTimer = null;

function checkForUpdates(userInitiated) {
  // Auto-update only works from a packaged app; skip in `npm start` dev.
  if (!app.isPackaged) {
    if (userInitiated) {
      updateState = "idle";
      refreshTray();
    }
    return;
  }
  if (updateState === "checking" || updateState === "downloading") return;
  updateState = "checking";
  refreshTray();
  autoUpdater.checkForUpdates().catch(() => {
    updateState = "error";
    refreshTray();
  });
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", () => {
    updateState = "downloading";
    refreshTray();
  });
  autoUpdater.on("update-not-available", () => {
    updateState = "idle";
    refreshTray();
  });
  autoUpdater.on("download-progress", () => {
    if (updateState !== "downloading") {
      updateState = "downloading";
      refreshTray();
    }
  });
  autoUpdater.on("update-downloaded", () => {
    updateState = "downloaded";
    refreshTray();
    // Passive tray state alone is missed by most users → they never restart,
    // never update. A notification actively surfaces it; clicking restarts.
    try {
      if (Notification.isSupported()) {
        const n = new Notification({
          title: "AgentScribe update ready",
          body: "A new version is downloaded. Restart to update.",
          silent: true,
        });
        n.on("click", () => {
          app.isQuitting = true;
          autoUpdater.quitAndInstall();
        });
        n.show();
      }
    } catch {
      /* the tray 'Restart to update' remains as the fallback */
    }
  });
  autoUpdater.on("error", () => {
    // Offline, no release yet, or (unsigned build) a verification hiccup —
    // all expected; degrade to manual download silently.
    updateState = "error";
    refreshTray();
  });

  // Check shortly after launch (let the UI settle first), then every 6 hours.
  setTimeout(() => checkForUpdates(false), 8000);
  updateTimer = setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000);
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
  saveState(); // hotkey moves fire "move" too, but persist explicitly to be safe
}

// Single entry point for every opacity change (presets, hotkeys, restore).
// Clamps to [OPACITY_MIN, 1], persists, and gives visible feedback: a brief
// title flash + tray tooltip, and refreshes the menus so the radio ticks match.
function applyOpacity(value, { flash = true } = {}) {
  if (!win) return;
  opacity = Math.min(1, Math.max(OPACITY_MIN, Math.round(value * 100) / 100));
  win.setOpacity(opacity);
  saveState();
  const pct = Math.round(opacity * 100);
  if (tray) tray.setToolTip(`AgentScribe — ${pct}% opacity`);
  refreshTray();
  buildMenu();
  if (flash) {
    try {
      win.setTitle(`AgentScribe — ${pct}%`);
      if (titleRevertTimer) clearTimeout(titleRevertTimer);
      titleRevertTimer = setTimeout(() => {
        if (win && !win.isDestroyed()) win.setTitle("AgentScribe");
      }, 1500);
    } catch {
      /* title feedback is a nicety; never block on it */
    }
  }
}

function adjustOpacity(delta) {
  applyOpacity(opacity + delta);
}

// Shared "Transparency" submenu for both the tray menu and the app menu. Radio
// presets show the current level at a glance; the steppers mirror the global
// hotkeys (shown as label hints — the real binding is the global shortcut, so we
// don't add an accelerator here and double-fire).
function transparencySubmenu() {
  const cur = Math.round(opacity * 10) / 10;
  const presets = OPACITY_PRESETS.map((v) => ({
    label: v === 1 ? "Solid (100%)" : `${Math.round(v * 100)}%`,
    type: "radio",
    checked: Math.abs(cur - v) < 0.001,
    click: () => applyOpacity(v),
  }));
  return [
    ...presets,
    { type: "separator" },
    { label: "More transparent  (Ctrl/⌘+Shift+[)", click: () => adjustOpacity(-OPACITY_STEP) },
    { label: "Less transparent  (Ctrl/⌘+Shift+])", click: () => adjustOpacity(OPACITY_STEP) },
    { label: "Reset to solid", click: () => applyOpacity(1) },
  ];
}

function toggleVisibility() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else win.show();
}

// ── In-app navigation (the app loads a web app that navigates: Live → History
// → a recording → sign-in). Give it browser-style Back / Forward / Home so a
// user is never stranded on a sub-page.
function goBack() {
  if (win && win.webContents.canGoBack()) win.webContents.goBack();
}
function goForward() {
  if (win && win.webContents.canGoForward()) win.webContents.goForward();
}
function goHome() {
  if (win) win.loadURL(APP_URL).catch(() => showError());
}

// One-time hint (per app run) the first time the X hides to the tray, so a
// user never thinks they quit and lost their session.
let hiddenNotified = false;
function notifyHiddenOnce() {
  if (hiddenNotified) return;
  hiddenNotified = true;
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: "AgentScribe is still running",
        body: "It's in your system tray. Click the tray icon to bring it back, or use the tray menu to quit.",
        silent: true,
      }).show();
    }
  } catch {
    /* notifications are a nicety; never block on them */
  }
}

function registerShortcuts() {
  globalShortcut.register("CommandOrControl+Shift+\\", toggleVisibility);
  globalShortcut.register("CommandOrControl+Shift+Up", () => move(0, -NUDGE));
  globalShortcut.register("CommandOrControl+Shift+Down", () => move(0, NUDGE));
  globalShortcut.register("CommandOrControl+Shift+Left", () => move(-NUDGE, 0));
  globalShortcut.register("CommandOrControl+Shift+Right", () => move(NUDGE, 0));
  globalShortcut.register("CommandOrControl+Shift+[", () => adjustOpacity(-0.1));
  globalShortcut.register("CommandOrControl+Shift+]", () => adjustOpacity(0.1));
  globalShortcut.register("CommandOrControl+Shift+H", goHome);
  globalShortcut.register("CommandOrControl+Shift+Q", () => {
    app.isQuitting = true;
    app.quit();
  });
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
      label: "Navigate",
      submenu: [
        { label: "Back", accelerator: "CommandOrControl+[", click: goBack },
        { label: "Forward", accelerator: "CommandOrControl+]", click: goForward },
        { label: "Home (Live)", accelerator: "CommandOrControl+Shift+H", click: goHome },
        { type: "separator" },
        { label: "Reload", accelerator: "CommandOrControl+R", click: () => win && win.reload() },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Show / Hide overlay", accelerator: "CommandOrControl+Shift+\\", click: toggleVisibility },
        { label: "Transparency", submenu: transparencySubmenu() },
        { type: "separator" },
        { label: "Quit AgentScribe", accelerator: "CommandOrControl+Shift+Q", click: () => { app.isQuitting = true; app.quit(); } },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function main() {
  // Last-resort main-process guards so an unexpected error is logged, not
  // silently swallowed (or crashing the whole app).
  process.on("uncaughtException", (err) => log("uncaughtException", err && err.stack ? err.stack : String(err)));
  process.on("unhandledRejection", (reason) => log("unhandledRejection", String(reason)));

  app.whenReady().then(() => {
    log("app ready — logs at", logFile());
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
    setupAutoUpdater();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Any genuine quit (Cmd/Ctrl+Q, OS shutdown, updater relaunch) sets the flag
  // BEFORE the window 'close' fires, so the close handler lets it through
  // instead of hiding to tray.
  app.on("before-quit", () => {
    app.isQuitting = true;
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    if (updateTimer) clearInterval(updateTimer);
  });
}
