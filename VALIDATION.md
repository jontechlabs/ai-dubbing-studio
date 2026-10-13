# Validation — Phase 1, 13 October 2026

## v0.1.2 local checks

The current frontend build, 8 TypeScript tests, 11 Rust tests, 5 Playwright scenarios, ESLint, Prettier, Clippy and rustfmt pass locally. New Rust scenarios extract SRT/ASS tracks from a generated bilingual MKV, preserve Unicode/timings/independent TTS edits, reject bitmap/invalid tracks, preserve data on conversion failure, and cancel queued extraction.

New browser scenarios verify loading until the first frame is available, a visible failure state instead of an endless spinner, automatic Processing display after creation, and original/translated embedded-track selection. The native IPC path in the interface scenario is mocked; the extraction integration test runs real FFmpeg. These are not a complete native GUI qualification.

The sections below record the initial release and v0.1.1 validation history.

## Passed locally

- Frontend production build and strict TypeScript, ESLint and Prettier checks.
- 8 TypeScript tests: SRT, timecodes, timeline calculations, conservative alignment, independent TTS text, project contracts and localization keys.
- 9 Rust tests on Ubuntu/WSL: parsing, FFprobe, serialization, recovery, path validation, real MKV import and job cancellation/retry/proxy persistence.
- Rust Clippy with `-D warnings` and rustfmt.
- 2 Playwright scenarios in Chrome: selection/playback/edit/autosave/reload/undo, and video/SRT import with persisted media.
- Windows x64 release cross-compilation from WSL using cargo-xwin, plus NSIS installer generation.
- An earlier Windows executable passed a native backend smoke test: FFmpeg-generated MKV, FFprobe inspection, project save/reload, Japanese subtitle preservation and independent TTS text.

## Windows CI checks for v0.1.1

The [clean Windows run](https://github.com/jontechlabs/ai-dubbing-studio/actions/runs/38362204358) passed the frontend build, 8 TypeScript tests, 2 browser scenarios, ESLint/Prettier, and the Rust test/Clippy/formatting step. It uses the same 9-test Rust suite on Windows MSVC.

The initial v0.1.0 workflow encountered an upstream Tauri test-manifest issue before Rust tests could start. v0.1.1 explicitly embeds Common Controls v6 in MSVC artifacts, including tests; the corrected test step passed. This is independent of native GUI and installer qualification.

## Native Windows limit

Smart App Control blocked an earlier unsigned Phase 1 executable on the development machine. The current Tauri Windows GUI, installation/uninstallation and WebView2 playback workflow remain unqualified. The earlier backend smoke test and browser scenarios do not establish complete native validation of the current build.

The setup and portable ZIP are unsigned development packages and the GitHub release is a prerelease. Windows execution policies may block them. Native Windows qualification and signing remain outstanding.

## Screenshots and other platforms

`docs/screenshots/studio.png` and `welcome.png` show the actual React app in the English browser preview. The browser does not run FFprobe or create native project folders. The bundled example is synthetic and contains no generated dubbing.

Linux/macOS GUI builds, ARM packages and AI inference are not qualified or shipped in this release.

## Repository workflow

The Windows workflow runs frontend/browser and Rust checks, builds an unsigned NSIS installer, and uploads packages as workflow artifacts. Its current run status is available under the repository's Actions tab. A successful workflow does not replace native GUI or installation qualification.
