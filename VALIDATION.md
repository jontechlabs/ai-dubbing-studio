# Validation - Phase 3, 13 October 2026

## v0.3.1 automated checks

The local frontend build, strict TypeScript, ESLint, Prettier, Rust Clippy with -D warnings and rustfmt pass. Suites contain 22 TypeScript tests, 15 Rust tests, 11 Playwright scenarios and 4 Python device tests (52 total).

Domain tests retain Phase 2 synchronization/editing coverage and add overlapping/large cue lookup, mixer mute/solo/master gain, legacy original-track creation, unsaved-edit rebase over audio jobs and integer split timestamps. Rust integration checks run actual FFmpeg media, validate real stem WAV structure/sample counts, preserve mixer asset metadata across reload, reject traversal and refuse separation without a runtime without modifying the project. Existing import/subtitle/waveform/cancellation/recovery checks remain.

Browser scenarios exercise 6,000 dialogues without subtitle-block mutations during playback, separation completion while text is unsaved, persistent mixer controls, pause/resume, GPU preference, update download failure/verified download/install state, repairing an existing incompatible CUDA installation, and earlier editing/import/player flows. Native commands and updater responses are mocked. Video, WAV elements and Web Audio run in Chrome.

## Real Bandit and isolated runtime

The official multilingual checkpoint was downloaded from Zenodo, verified against its published MD5 and locked SHA-256 abcfccf65446752a057f4a302c941479a54b7560ebf8d7bca039d2ea98e64cfc. Upstream model code is vendored unchanged at d5563d9031e95fdaa3e5a73d5020b9a0df61adb6.

Real CPU inference succeeded on Windows using a one-second, 48 kHz stereo synthetic excerpt, producing three WAVs. Another run succeeded with the exact Python 3.12.10 embedded runtime, pip bootstrap and pinned libraries used by application installation, independent of system Python. These validate integration/output structure, not quality on a full film or every language.

Version 0.3.1 switches the NVIDIA runtime index from cu126 to the official PyTorch 2.8 cu128 builds. The CPU inference regression succeeded with the embedded runtime. Four device tests simulate a CPU-only installation, an enumerated GPU with failing kernels, another usable GPU after GPU 0 fails, and explicit device selection. A small real CUDA kernel is executed during discovery; this verifies basic device usability, not complete Bandit inference.

CUDA inference remains unqualified on this development host. AMD/Intel/Metal/DirectML inference is unsupported by this Bandit integration. Linux/macOS runtime installation and ARM packages are not shipped.

## Update signatures and Windows

Windows x64 application and NSIS packages are built with cargo-xwin and an updater signature. Separate Minisign verification with the configured public key accepts the installer signature and rejects a modified installer. The private key stays outside Git; Windows Actions reads it from a repository secret. This is separate from Authenticode.

The [Windows workflow](https://github.com/jontechlabs/ai-dubbing-studio/actions/workflows/windows.yml) repeats frontend/browser/Rust checks and builds/signs packages. See Actions for the current commit result. It does not install the large Bandit runtime/model or qualify CUDA.

An earlier unsigned executable was blocked by Smart App Control. Final native Tauri GUI, installer/uninstaller, effective WebView2 GPU adapter and complete native update/restart remain unqualified. Mocked IPC does not establish those outcomes. Windows rendering preference is an OS request for this executable; it does not guarantee a specific WebView2/decoder adapter.

Screenshots show actual French React UI in browser testing, with simulated native devices/stems/update metadata. The displayed 0.3.2 update is a test scenario, not a released version. Screenshots are not native Tauri captures. The demo has synthetic audio and no generated dubbing.

Format 1 projects open normally. Adding separated tracks uses format 2, rejected by old app versions. Split text allocation is approximate; SRT synchronization uses timings and does not align speech. Final mix/MKV export and voice generation remain future phases.

## Earlier validation

The [v0.2.0 Windows run](https://github.com/jontechlabs/ai-dubbing-studio/actions/runs/38379413340) passed its checks and packaging. Earlier suites include bilingual MKV extraction and the corrected Common Controls v6 MSVC test manifest.
