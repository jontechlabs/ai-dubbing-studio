# Validation - Phase 4, 14 October 2026

## v0.4.1 automated checks

The local frontend build, strict TypeScript, ESLint, Prettier, Rust Clippy with -D warnings and rustfmt pass. Suites contain 27 TypeScript tests, 34 Rust tests on Linux (33 on Windows), 21 Playwright scenarios and 10 Python device/process/grouping tests (92 locally, 91 on Windows).

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

Screenshots show actual French React UI in browser testing, with simulated native devices/stems/update metadata. The displayed 0.4.2 update is a test scenario, not a released version. Screenshots are not native Tauri captures. The demo has synthetic audio and no generated dubbing.

Format 1 projects open normally. Adding separated tracks uses format 2, rejected by old app versions. Split text allocation is approximate; SRT synchronization uses timings and does not align speech. Final mix/MKV export and voice generation remain future phases.

## Bandit download regression

The user reported HTTP 403 from Zenodo after successful Python/PyTorch dependency installation. Version 0.3.2 uses an attributed, unchanged GitHub mirror with public Zenodo fallback. Six Rust HTTP tests cover 403 fallback with User-Agent, hash mismatch without overwriting the previous file, short/oversized data, verified offline cache, retry after HTTP 503, and cancellation while awaiting headers. A seventh test refuses dependency reuse for the wrong CPU/CUDA variant, CUDA 12.6, incomplete checks or the wrong Torch version.

The full 446,680,129-byte mirror was downloaded by the production Rust downloader with its real HTTPS client. Exact size and SHA-256 matched the official checkpoint; a second call reused the verified file without a network request. The embedded Python runtime passed the new full import/version probe used for dependency reuse. A CPU inference regression is recorded separately. These tests do not yet establish successful CUDA separation on the user's RTX 5060 Ti or the complete native installer flow on that machine.

## Earlier validation

The [v0.2.0 Windows run](https://github.com/jontechlabs/ai-dubbing-studio/actions/runs/38379413340) passed its checks and packaging. Earlier suites include bilingual MKV extraction and the corrected Common Controls v6 MSVC test manifest.

## Windows installation finalization regression

With the exact embedded Python 3.12.10 runtime, the previous `--info` worker stayed running for 20 seconds while its stdin pipe remained open and exited after that pipe was closed. The fixed real `--info` and full `--runtime-info` probes exit with stdin still open in about 2 and 6 seconds. Real CPU inference using the verified checkpoint and the same open-pipe transport produced all three one-second WAVs and exited successfully in 26 seconds. Blocking raw stdin was also tested and rejected because it stalled Torch initialization on Windows; the final control reader uses nonblocking pipe reads supported by Python 3.12.

Three Python process tests cover actual CLI exit with open stdin, control-reader shutdown, and pause/resume delivery. They replace heavy imports for CI and complement the real embedded-runtime run. Two Rust process tests exercise closed-stdin JSON collection, a stalled probe deadline, and cancellation. The additional browser scenario checks the visible device-check stage, indeterminate progress, CPU availability after failed GPU discovery and successful refresh. Native IPC is mocked in that browser test. GPU discovery failure does not reclassify a verified installation as missing. The GPU probe checks basic kernels; full RTX 5060 Ti inference remains unqualified on this host.

## Phase 4 speaker identification and UI

The exact isolated Python 3.12.10 runtime successfully imports sherpa-onnx/core 1.13.8 and NumPy 2.2.6 extracted from hash-locked Windows wheels. The unchanged CAMPPlus ONNX and Silero VAD models were downloaded from official k2-fsa assets and hashed. Real CPU inference on four subtitle intervals containing two distinct Windows SAPI test voices grouped their repetitions together and produced two candidate reference WAVs. A separate three-second silent input returns NO_SPEECH_FOUND. The initial 0.6 grouping threshold merged the two similar synthetic voices; the shipped, more conservative default is 0.75, with a user-adjustable setting. Similarity is not a calibrated probability of speaker identity.

This establishes model/runtime integration on this host, not diarization quality on Japanese anime, expressive/overlapping voices or a full film. Identification is anonymous embedding clustering over existing subtitle intervals, not person recognition or continuous full-audio segmentation. Reads are limited to 15 seconds per interval; short/ambiguous lines remain unassigned and at most 32 groups are proposed. No model weights or private signing keys are bundled.

Four new domain tests cover serialized profiles/assignments, proposal application that preserves manual assignments and rejects changed timings, preserving a newly extracted reference during an unsaved rename, and subtitle display preferences without deleting cue text/times. Two Rust integration checks use a real mono 24 kHz WAV and format-3 save/load, reject invalid reference paths/default ids, and refuse identification without an installed runtime before creating jobs. Three Python tests cover clustering distinct/repeated vectors, uncertain capped clustering and invalid vectors.

Four additional browser scenarios exercise AI proposal application with manual corrections, editable references and engine preference, inline translation plus saved timeline/player controls, successful automatic synchronization at import, and preserving imported mismatched subtitles when synchronization is refused. Native inference/reference IPC is simulated in the UI tests; browser video/audio elements run normally. The source archive and portable package are checked for model files, Python caches and signing keys. Native GUI, full installed-app model download/identification and installer/update cycle remain unqualified on this development host; Windows Actions validates the frontend, Rust and Python code and packages separately.

TTS engine preferences are saved preparation metadata. CosyVoice3/Fish/Qwen generation is not implemented in this release. Speaker names are entered manually. Manual references may be imported or extracted, with normalization and a 20-second cap; AI references are candidate speech-only clips requiring review and transcript correction. Per-generation/per-line reference-mode selection remains TTS-stage work. Projects using profiles/preferences are format 3, refused by older app versions; formats 1 and 2 remain readable.

## Model migration and audible mute regression (v0.4.1)

The command integration test blocks a busy migration and reuses the moved speaker installation through the production status path. Production Rust migration tests copy model/runtime trees, verify bytes and durable configuration reload, remove originals after commit, cancel mid-copy with staging cleanup, refuse conflicting/nested destinations and linked files, roll back published directories when configuration saving fails, preserve files added during copying, and retain a configured unavailable drive without silently falling back. Links are tested on Linux; Windows code also rejects reparse points. Cross-volume operation uses copy/verify rather than filesystem rename for the source transfer; a physical two-drive Windows move is not yet qualified here.

Chrome Web Audio tests tap actual output gains with analyser nodes: audible original, all tracks silent, selected stem audible, silence after save/reload, replacement of a playing media element with the same URL, and no embedded soundtrack leakage after an audio-graph initialization failure. Tests assert native video mute as well as output sample energy. They use real decoded video/WAV audio, with mocked project IPC. Native WebView2 playback on the user’s hardware remains to be confirmed.

GGUF/FP8/BF16 catalogue selections persist and reject variants belonging to a different engine. UI checks expose provenance, the complete required engine, the source-reported FP8 memory figure and the 24 GB BF16 warning. Catalogue entries are preparation metadata: no TTS weights or third-party runtime are installed, and no quantized TTS inference is claimed.
