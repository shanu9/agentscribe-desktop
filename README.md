# AgentScribe Desktop

A thin Electron shell that loads the AgentScribe web app in a window the
operating system **excludes from screen capture**. This is the only way to make
the copilot truly invisible during screen-share — something a browser tab can
never do.

## Why this exists

A web page (even in Picture-in-Picture "Hide Mode") is always visible under
**Share Entire Screen**, OS screenshots, and screen recorders. The browser
sandbox gives web content no way to opt out of capture.

This wrapper calls one native API — `BrowserWindow.setContentProtection(true)`
([main.js](main.js)) — which maps to:

| OS | Mechanism | Result |
|----|-----------|--------|
| Windows | `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` | Window absent from all capture |
| macOS | `NSWindow.sharingType = .none` | Window absent from all capture |

The overlay stays fully visible **to you**, but appears blank/absent in:
Share Entire Screen, Zoom/Meet/Teams, OS screenshot tools, and most recorders.

> **Known limits:** It can't stop a phone camera pointed at your screen, and
> Linux capture-exclusion support is unreliable (Windows + macOS are solid).

## Run it (development)

1. Start the web app in another terminal:
   ```bash
   cd ../website && npm run dev
   ```
2. Launch the desktop overlay:
   ```bash
   cd desktop
   npm install        # first time only (downloads Electron)
   npm start
   ```

It defaults to `http://localhost:3000/scribe`.

## Point it at production

```bash
AGENTSCRIBE_URL=https://your-domain.com/scribe npm start
```

## Global hotkeys (work even when the window isn't focused)

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + Shift + \` | Show / hide the overlay (panic key) |
| `Cmd/Ctrl + Shift + ↑ ↓ ← →` | Move the window |
| `Cmd/Ctrl + Shift + [` / `]` | Dim / brighten |
| `Cmd/Ctrl + Shift + Q` | Quit |

Drag the small handle at the top-center to reposition with the mouse.

## Package installers

```bash
npm run dist:mac   # → dist/AgentScribe.dmg
npm run dist:win   # → dist/AgentScribe-Setup.exe   (run on Windows)
```

Artifact names are pinned in `package.json` (`artifactName`) so they match the
website download links in `website/src/app/scribe/download/links.ts`:

| Platform | File | Link constant |
|----------|------|---------------|
| macOS | `AgentScribe.dmg` | `DOWNLOADS.mac` |
| Windows | `AgentScribe-Setup.exe` | `DOWNLOADS.windows` |

Build each on its target OS (or in CI). After uploading both to a GitHub
Release, set `GH_OWNER_REPO` in that `links.ts` to flip the site's buttons live.

### Code-signing & notarization

Unsigned builds run, but users hit macOS Gatekeeper ("unidentified developer")
and Windows SmartScreen warnings. To sign, set env vars before `npm run dist:*`
— electron-builder picks them up automatically:

**macOS** (requires an Apple Developer "Developer ID Application" cert):
```bash
export CSC_LINK=/path/to/DeveloperID.p12      # or import the cert into your keychain
export CSC_KEY_PASSWORD=********
# Notarization (required for distribution outside the App Store):
export APPLE_ID=you@example.com
export APPLE_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop
export APPLE_TEAM_ID=XXXXXXXXXX
```
The macOS build already enables **hardened runtime** and ships
[`build/entitlements.mac.plist`](build/entitlements.mac.plist) (mic access +
the JIT entitlements Electron needs), so it's notarization-ready once the
Apple env vars are present.

**Windows** (code-signing cert):
```bash
export CSC_LINK=/path/to/cert.pfx
export CSC_KEY_PASSWORD=********
```

### Plug-and-play CI signing (recommended)

The release workflow ([`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml))
already reads the signing secrets — you just have to set them once, then every
tagged build comes out signed + notarized with **no Gatekeeper/SmartScreen
warning**. First-time setup:

1. **Get an Apple Developer account** ($99/yr) → https://developer.apple.com/programs/
2. In **Certificates, IDs & Profiles**, create a **Developer ID Application**
   certificate, then export it from Keychain Access as a `.p12` (set a password).
3. Base64-encode it for GitHub (secrets can't hold binary):
   ```bash
   base64 -i DeveloperID.p12 | pbcopy   # now in your clipboard
   ```
4. Create an **app-specific password** at https://appleid.apple.com → Sign-In &
   Security → App-Specific Passwords. Find your **Team ID** in the membership page.
5. In the GitHub repo → **Settings → Secrets and variables → Actions**, add:

   | Secret | Value |
   |--------|-------|
   | `CSC_LINK` | the base64 string from step 3 |
   | `CSC_KEY_PASSWORD` | the `.p12` password from step 2 |
   | `APPLE_ID` | your Apple ID email |
   | `APPLE_APP_SPECIFIC_PASSWORD` | from step 4 |
   | `APPLE_TEAM_ID` | your 10-char Team ID |
   | `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | (optional) base64 `.pfx` + password for Windows |

6. Cut a release: bump `version` in `package.json`, then
   `git tag v0.2.0 && git push --tags`. CI builds both installers, signs +
   notarizes the Mac one, and attaches them to a draft GitHub Release.

> electron-builder 25 notarizes automatically whenever `APPLE_ID` +
> `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` are present (and skips with a
> warning when they're absent), so no extra config is needed — the secrets are
> the only switch.

### Until it's signed (current state)

Builds are currently **unsigned**, so first launch shows a warning. The website
download page ([`/scribe/download`](../website/src/app/scribe/download/DownloadPanel.tsx))
walks users through the safe bypass:
- **Mac:** right-click → Open, or `xattr -dr com.apple.quarantine /Applications/AgentScribe.app`
- **Windows:** "More info" → "Run anyway"

## Notes

- The web app's in-browser "🫥 Hide Mode" (PiP) button is redundant here — the
  entire window is already capture-protected.
- Mic and `getDisplayMedia` permissions are granted automatically by the shell
  ([main.js](main.js)) so "Start mic" / "Share tab audio" work without prompts.
- Security: the remote app runs with `contextIsolation` on, `nodeIntegration`
  off, `sandbox` on, and an empty [preload.js](preload.js) — no Node access is
  exposed to web content.
