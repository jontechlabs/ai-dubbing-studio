# Validation — Phase 1, 13 October 2026

## Passed locally

- Frontend production build and strict TypeScript, ESLint and Prettier checks.
- 8 TypeScript tests: SRT, timecodes, timeline calculations, conservative alignment, independent TTS text, project contracts and localization keys.
- 9 Rust tests on Ubuntu/WSL: parsing, FFprobe, serialization, recovery, path validation, real MKV import and job cancellation/retry/proxy persistence.
- Rust Clippy with `-D warnings` and rustfmt.
- 2 Playwright scenarios in Chrome: selection/playback/edit/autosave/reload/undo, and video/SRT import with persisted media.
- Windows x64 release cross-compilation from WSL using cargo-xwin, plus NSIS installer generation.
- An earlier Windows executable passed a native backend smoke test: FFmpeg-generated MKV, FFprobe inspection, project save/reload, Japanese subtitle preservation and independent TTS text.

## Native Windows limit

Smart App Control blocked the final unsigned executable on the development machine. The final Tauri Windows GUI, installation/uninstallation and WebView2 playback workflow are therefore not fully validated. The earlier backend smoke test and browser scenarios do not establish complete native validation of the final build.

The setup and portable ZIP are unsigned development packages and the GitHub release is a prerelease. Windows execution policies may block them. Native Windows qualification and signing remain outstanding.

## Screenshots and other platforms

`docs/screenshots/studio.png` and `welcome.png` show the actual React app in the English browser preview. The browser does not run FFprobe or create native project folders. The bundled example is synthetic and contains no generated dubbing.

Linux/macOS GUI builds, ARM packages and AI inference are not qualified or shipped in this release.

## Repository workflow

The Windows workflow runs frontend/browser and Rust checks, builds an unsigned NSIS installer, and uploads packages as workflow artifacts. Its current run status is available under the repository's Actions tab. A successful workflow does not replace native GUI or installation qualification.
