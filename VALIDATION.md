# Validation — Phase 2, 13 October 2026

## v0.2.0 checks

The frontend production build, strict TypeScript, ESLint, Prettier, Rust Clippy with `-D warnings` and rustfmt pass locally. The test suites contain **16 TypeScript tests, 13 Rust tests and 7 Playwright scenarios** (36 tests total).

- Timing tests cover positive/negative offsets, affine drift, either reference role, missing cues, one-to-many grouping, refusal of insufficient/periodic ambiguity, unchanged text/reference timings, preserved TTS overrides and generation assets, actual SRT export timings, independent cue edits, grapheme-safe splits, merge and range rejection.
- Rust integration tests run real FFmpeg on generated media: bilingual SRT/ASS MKV extraction and import/proxy/recovery scenarios, selected-track waveform decoding with initial audio delay, silent-track selection, waveform cache reuse, invalid stream failure, and cancellation of a queued waveform while project edits remain available.
- Browser scenarios verify first-frame loading/failure, Processing visibility, embedded-track selection, automatic-calage preview/apply/export/undo/redo/reload, waveform canvas output, timecode editing, drag/resize, split/merge and persistence. They also retain the existing text/TTS/playback/import checks. Native IPC in the embedded-track interface scenario is mocked; backend integration tests run actual FFmpeg.

The [Windows workflow](https://github.com/jontechlabs/ai-dubbing-studio/actions/workflows/windows.yml) repeats frontend/browser and Rust checks on Windows MSVC, builds an unsigned NSIS installer and uploads packaged artifacts. See Actions for the current commit’s result. A passing workflow does not establish complete native GUI or installation qualification.

## Distribution and native Windows limit

Windows x64 executable and NSIS setup are cross-compiled from WSL using cargo-xwin. The portable ZIP contains the same executable, FFmpeg/FFprobe, their license, synthetic demo, documentation and screenshots. SHA256SUMS.txt records the distributed package hashes.

Smart App Control blocked an earlier unsigned Phase 1 executable on the development machine. The final Tauri Windows GUI, installation/uninstallation and WebView2 playback workflow remain unqualified on this machine. Earlier backend smoke checks and browser scenarios do not establish full native validation of this build. Packages are unsigned development builds and the GitHub release remains a prerelease. Signing and native qualification remain outstanding.

## Screenshots and feature limits

The screenshots show the actual French React app in Chrome browser preview, with a synthetic example and generated timing-test subtitles. They are not captured native Tauri windows. The bundled example has synthetic audio and no generated dubbing.

Phase 2 automatic synchronization compares SRT timing patterns. It does not perform speech recognition, audio forced alignment or semantic translation matching. Ambiguous proposals are refused; unmatched cues retain their original timings. Split text distribution is approximate and requires review. Different video edits can require manual adjustment.

Linux/macOS GUI builds, ARM packages, model installation and AI inference are not qualified or shipped in this release. Project format 1 remains compatible with existing project folders.

## Earlier releases

The [v0.1.2 Windows run](https://github.com/jontechlabs/ai-dubbing-studio/actions/runs/38370316226) passed 8 TypeScript, 11 Rust and 5 browser tests and packaging. The [v0.1.1 run](https://github.com/jontechlabs/ai-dubbing-studio/actions/runs/38362204358) corrected the original Tauri test-manifest issue by embedding Common Controls v6 in MSVC artifacts, including tests.
