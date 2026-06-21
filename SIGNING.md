# AgentScribe Desktop — Code Signing (remove the install warnings)

Unsigned, the app still works — but Windows shows a blue **"SmartScreen — unknown
publisher"** warning and macOS shows **"unidentified developer."** Signing removes
both. electron-builder is **already wired** to sign from environment variables —
you don't change any code, you just provide a certificate + set env vars, then
run the normal `npm run dist:win` / `dist:mac`.

---

## Windows

### What you need
A **code-signing certificate** (a `.pfx`/`.p12` file + its password):
- **OV (Organization Validation)** — ~$120–200/yr. Cheaper, but SmartScreen
  reputation builds up over the first ~weeks/downloads.
- **EV (Extended Validation)** — ~$300+/yr, often on a hardware token/cloud HSM.
  **Clears SmartScreen instantly.** Recommended if you want zero warnings on day one.

Buy from a CA (Sectigo, DigiCert, SSL.com, Certera, etc.).

### Build a signed installer
Set these env vars, then build:
```bash
# macOS/Linux shell
export CSC_LINK="/absolute/path/to/your-cert.pfx"     # or a base64 string of the file
export CSC_KEY_PASSWORD="your-pfx-password"
cd desktop && npm install && npm run dist:win
```
```powershell
# Windows PowerShell
$env:CSC_LINK="C:\path\to\your-cert.pfx"
$env:CSC_KEY_PASSWORD="your-pfx-password"
cd desktop; npm install; npm run dist:win
```
electron-builder detects `CSC_LINK` + `CSC_KEY_PASSWORD` and signs
`AgentScribe-Setup.exe` automatically. Verify: right-click the `.exe` →
**Properties → Digital Signatures** → your org should be listed.

> EV certs on a hardware token: signing happens through the token's tooling —
> follow the CA's electron-builder + token instructions (set
> `WIN_CSC_LINK`/token options per their guide). The build command is the same.

---

## macOS (for the .dmg)

### What you need
- **Apple Developer Program** ($99/yr).
- A **"Developer ID Application"** certificate (created in Xcode or the Apple
  developer portal) installed in your login keychain.
- An **app-specific password** for notarization (appleid.apple.com → Sign-In &
  Security → App-Specific Passwords).

### Build a signed + notarized DMG
```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="YOURTEAMID"
export CSC_LINK="/path/to/DeveloperIDApplication.p12"   # optional if cert is in keychain
export CSC_KEY_PASSWORD="cert-password"
cd desktop && npm run dist:mac
```
The build already sets `hardenedRuntime: true` + entitlements. To enable
notarization, add `"notarize": true` under `build.mac` in `package.json` (leave
it off while you build unsigned, or it will fail without the Apple creds).

---

## CI note (optional, later)
For automated releases, put `CSC_LINK` (base64), `CSC_KEY_PASSWORD`, and the
Apple vars in your CI secrets and run `npm run dist`. Never commit the cert or
passwords to git.

## Summary
- **Code: no changes needed** — signing is env-driven and already supported.
- **Windows:** buy a cert → set `CSC_LINK` + `CSC_KEY_PASSWORD` → `npm run dist:win`.
- **Mac:** Apple Developer cert + app-specific password → `npm run dist:mac`.
- EV (Windows) = no SmartScreen warning from day one.
