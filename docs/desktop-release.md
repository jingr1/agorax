# Desktop release (Electron)

Agorax ships a native desktop shell via Electron. Installers are built and
attached to GitHub Releases by `.github/workflows/desktop-release.yml`.

Docker / GHCR images (`docker-publish.yml`) are a **separate** server/Web
deployment path. They do not contain Electron installers.

## Quick start

1. Push a semver tag:

   ```bash
   git tag v1.2.3
   git push origin v1.2.3
   ```

2. The **Desktop Release** workflow builds macOS (DMG), Windows (NSIS + portable
   `.exe`), and Linux (AppImage) in parallel, then uploads assets to the
   `v1.2.3` GitHub Release.

3. Download from https://github.com/jingr1/agorax/releases

To rebuild an existing tag without retagging, use **Actions → Desktop Release →
Run workflow** and enter the tag (e.g. `v1.2.3`).

## Local builds

```bash
pnpm electron:build        # current platform
pnpm electron:build:mac
pnpm electron:build:win
pnpm electron:build:linux  # AppImage; run on Linux
```

Artifacts land in `release/`. Scripts use `--publish never`; CI publishes via
`softprops/action-gh-release`.

## Signing (optional)

If the secrets below are **missing**, CI still succeeds and publishes
**unsigned** packages (`CSC_IDENTITY_AUTO_DISCOVERY=false`). macOS Gatekeeper
and Windows SmartScreen may require a manual allow.

| Secret | Platform | Purpose |
|--------|----------|---------|
| `MACOS_CSC_LINK` | macOS | Developer ID Application certificate (URL, path, or base64 `.p12`) |
| `MACOS_CSC_KEY_PASSWORD` | macOS | Password for the `.p12` |
| `APPLE_API_KEY_P8_BASE64` | macOS | App Store Connect API key (`.p8` base64) for notarization |
| `APPLE_API_KEY_ID` | macOS | API key id |
| `APPLE_API_ISSUER` | macOS | API issuer UUID |
| `WIN_CSC_LINK` (or `CSC_LINK`) | Windows | Code-signing certificate (URL, path, or base64 `.p12`) |
| `WIN_CSC_KEY_PASSWORD` (or `CSC_KEY_PASSWORD`) | Windows | Password for the certificate |

Linux AppImages are not code-signed in this workflow.

When macOS signing secrets are present, CI also sets
`mac.hardenedRuntime=true` for the electron-builder invocation.

## Auto-update feed

`electron-builder.config.cjs` publishes to GitHub provider
`jingr1/agorax`. The desktop shell’s `electron-updater` uses that feed, so
in-app update checks look at this repository’s Releases.

## Relation to Docker

| Path | Workflow | Artifact |
|------|----------|----------|
| Desktop app | `desktop-release.yml` | DMG / EXE / AppImage on GitHub Release |
| Server / Web | `docker-publish.yml` | `ghcr.io/.../agorax` container |

Do not expect Electron binaries inside the Docker image. The image runs
`node server-entry.js` only.
