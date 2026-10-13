# Build and package

## Windows prerequisites

The development toolchain used Node.js 24.19.0, pnpm 11.25.0 and Rust stable. JavaScript/Rust dependency resolutions are committed in both lockfiles. Install [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/), including MSVC C++ build tools, Windows SDK and WebView2 on Windows.

```powershell
pnpm install --frozen-lockfile
powershell -NoProfile -File scripts/prepare-ffmpeg.ps1
pnpm desktop
```

`prepare-ffmpeg.ps1` downloads the versioned Gyan.dev FFmpeg 9.0.2 essentials archive specified in `resources/toolchain.json`. It verifies SHA-256 before extracting and copying `ffmpeg.exe`, `ffprobe.exe` and the license to `src-tauri/binaries/`. A hash mismatch stops preparation. The Git repository excludes the executable files and download cache.

For an existing archive, pass `-ArchivePath C:\path\ffmpeg.zip`. Downloaded archives/extractions remain in `.cache/` for inspection. The script uses Windows PowerShell/.NET only; it does not change execution policies or machine security settings.

## Browser preview

```powershell
pnpm dev
```

Open `http://127.0.0.1:1420`. This runs the React interface with IndexedDB-backed preview storage. FFprobe and native folder persistence require the desktop app. No cloud server is involved.

## Checks

```powershell
pnpm build
pnpm test
pnpm lint
pnpm format:check
pnpm test:e2e
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

The browser scenarios use installed Google Chrome and manage their Vite server automatically. Windows Rust integration tests use the prepared FFmpeg tools; Linux Rust tests use `ffmpeg` and `ffprobe` on PATH. Test reports/screenshots stay in ignored directories.

Windows MSVC artifacts explicitly embed the Common Controls v6 manifest, including the Rust test executable. This addresses the upstream [Tauri test-manifest issue](https://github.com/tauri-apps/tauri/issues/13419) that can cause `STATUS_ENTRYPOINT_NOT_FOUND` before tests start. The initial v0.1.0 Windows workflow encountered that issue; v0.1.1 includes the build correction.

The GitHub workflow runs the checks on Windows, builds an NSIS installer and uploads unsigned packages as workflow artifacts. It does not automatically publish a release or sign binaries. CI success does not qualify installation or native GUI playback.

## Windows packages

```powershell
pnpm desktop:build
powershell -NoProfile -File scripts/package-windows.ps1
```

Tauri outputs its executable in `src-tauri/target/release/` and NSIS installer in `src-tauri/target/release/bundle/nsis/`. The packaging script validates its inputs and creates:

- `artifacts/AI-Dubbing-Studio-0.3.2-Setup.exe`
- `artifacts/AI-Dubbing-Studio-Windows-Portable.zip`
- `artifacts/SHA256SUMS.txt`

The ZIP includes the executable, FFmpeg tools/license, synthetic demo and documentation. The setup installs for the current user. Consult [Tauri's Windows installer documentation](https://v2.tauri.app/distribute/windows-installer/) for the underlying NSIS and WebView2 behavior.

For another target directory or cross-built artifacts, pass explicit paths:

```powershell
powershell -NoProfile -File scripts/package-windows.ps1 -ExecutablePath C:\build\ai-dubbing-studio.exe -InstallerPath C:\build\setup.exe -OutputDirectory C:\build\packages
```

The current release was cross-built from Ubuntu/WSL using `cargo-xwin` for `x86_64-pc-windows-msvc`. Native Windows builds follow the standard commands above. See [validation](../VALIDATION.md) for why local Windows execution remains limited.

## Other platforms

The source uses Tauri's platform abstractions, but this release publishes **Windows x64 only**. Linux/macOS GUI builds and installers have not been qualified. Windows FFmpeg binaries cannot be reused there; provide native tools. The current bundle target is NSIS and must be changed for platform-appropriate packaging. No ARM build is provided.

## Updater signing

Release builds require `TAURI_SIGNING_PRIVATE_KEY` (key file path or content) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty for the configured key). The public key is embedded in Tauri configuration; never commit the private key. The Windows workflow reads the repository Actions secret. Packages include `.exe.sig`. `scripts/create-update-manifest.ps1` produces a manifest using the distributed installer signature; publish its versioned installer/signature assets before updating the endpoint in `resources/updates/windows-x64.json`.

The portable package copies only declared worker resources, excluding Python development caches. Models and inference libraries are installed later from the interface and are not bundled in the setup. The Bandit code license and provenance are packaged beside the adapter.
