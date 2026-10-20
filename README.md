# AI Dubbing Studio

**v0.20.1 — Installer and MCP relay shutdown.** Relays exit when the studio closes; updates suspend MCP and allow the executable to be released. Failed installations restore MCP. [Recovery for older versions and details (French)](docs/INSTALLATION-RECOVERY.md).

**v0.20.0 — Experimental intonation transfer.** Transform an existing French take using pitch, rhythm and energy contours from the original Japanese dialogue or another reference. Adjustable strength, local CPU processing and an independent new take preserve every previous take and the source video. Cross-language acoustic transfer remains approximate. Also available through MCP (95 tools). [Guide, limits and screenshot](docs/PROSODY-TRANSFER.md).

![Intonation transfer](docs/screenshots/prosody-transfer-fr.png)

*Actual React UI with simulated native commands / Interface réelle, commandes natives simulées.*

**v0.19.0 — Control the studio through MCP.** Enable the local stdio server in Settings and connect an AI client using the generated JSON or Codex TOML configuration. 93 typed tools cover projects, subtitle/voice/audio editing, generation, lip sync, playback, jobs, exports and updates. Project revisions, undo and audio-render preflight remain enforced. The application stays open during this first integration. [Setup and guide (French)](docs/MCP.md).

![MCP configuration](docs/screenshots/mcp-settings-fr.png)

*Actual React UI with simulated native commands / Interface réelle, commandes natives simulées.*

**v0.18.0 — Batch lip sync and safer audio editing.** Process all dubbed or checked dialogue lines with CPU face detection for filmed people and anime, editable individual framing, cancellation and resume. Each result is an independent clip; the main video stays intact. Cuts and stretches render before committing, the original take remains auditionable, and multiline dialogue cards no longer overlap. An audio-clock playhead and precise counter help locate the sound and place the editing cursor. [Guide and screenshots (French)](docs/LIP-BATCHES-AND-AUDIO-RECOVERY.md).

![Batch lip synchronization](docs/screenshots/lip-batch-fr.png)

*Actual React UI with synthetic media and simulated native commands / Interface réelle, commandes natives simulées.*

**v0.17.0 — LatentSync 1.5 and 1.6, adapted from ShmuelRonen’s wrapper.** Select an engine, check disk capacity and retouch separate dialogue sequences. The main video stays intact; enabled variants preload for playback and compose on export. Reduced-memory profile uses temporal windows, sequential guidance and a separately loaded VAE. The 1.6 profile remains a 16 GB candidate, without an RTX 5060 Ti no-OOM guarantee. [Detailed guide](docs/LATENTSYNC.md).

![LatentSync engine selection](docs/screenshots/latentsync-profiles-fr.png)

*Interface React réelle avec média synthétique et commandes natives simulées ; diagnostics neuronaux CPU séparés.*

**v0.16.0 — Right-click menus.** Remove a volume or mute region directly from any audio track, with undo/redo and persistence. Clear an unapplied selection, toggle a track or open audio options. The application menu provides Undo, Redo, Save and Settings. [Illustrated guide](docs/CONTEXT-MENUS.md).

**v0.15.1 — Protected voice duration and movement.** Editing shows the actual available maximum, stops at neighbouring voices and the video end, and enforces the 120-second processing limit. Moves preserve audible duration; numeric timing applies on Enter/blur. Existing oversize or collapsed timings have a recovery action that retains edits. [Illustrated guide (French)](docs/VOICE-DURATION-SAFETY.md).


**v0.15.0 — Adjustable voice fades, audio selection resizing and coherent navigation.** Apply fade-in/out to a voice region, resize audio selections or saved gain/mute regions with their edge handles, and reveal the chosen dialogue and playhead without changing timeline zoom. [Illustrated guide (French)](docs/FADES-SELECTION-NAVIGATION.md).

![Adjustable voice fades](docs/screenshots/voice-fades-fr.png)

*Actual React interface with synthetic demo audio and simulated native commands; separate real FFmpeg sample and MKV checks.*


**v0.14.0 — Edit parts of a generated voice directly on the timeline.** Double-click a dubbing clip to select a waveform region, insert silence, mute, delete and close its gap, adjust local volume, or drag ↔ to stretch only that region while preserving pitch. Originals are retained; edits support undo, autosave, WAV and synchronized MKV export. [Illustrated guide (French)](docs/VOICE-REGION-EDITING.md).

![Local dubbing audio editor](docs/screenshots/voice-region-editor-fr.png)

*Actual React interface with synthetic demo audio and simulated native commands; audio rendering and MKV export are tested separately with real FFmpeg.*



**v0.13.0 — Translation status filters, approved-only batch dubbing and local Qwen3-4B-Instruct-2507 GGUF Q4_K_M proposals.** Open the translation assistant in the subtitle editor, install its model, choose a GPU, then review and edit the proposal before applying it. Translation approval remains manual. [Detailed guide (French)](docs/TRANSLATION-ASSISTANT.md).

![Local translation proposal for review](docs/screenshots/translation-assistant.png)

*Actual React UI; native model inventory and displayed proposal are simulated for the screenshot. Real local model checks are recorded in VALIDATION.md.*

**v0.12.0** keeps the model loaded for each dubbing batch, then terminates its process before reporting completion or cancellation. Dialogue cards now show untranslated (grey), translated (light green) and explicitly approved translation (green). Translation approval is independent from voice-take approval and is revoked when source/target text or languages change. [Guide and screenshot](docs/BATCH-CACHE-AND-TRANSLATION-REVIEW.md).


**v0.11.0 — Reference excerpts and batch dubbing.** Choose and audition start/end times before importing an audio reference. Dub all translated lines or checked lines with a common configuration, keep current takes or force new ones, and track/cancel/resume the batch. Previous takes are retained. [Guide and screenshots](docs/BATCH-DUBBING.md).

![Batch dubbing](docs/screenshots/batch-configuration.png)

*Actual React UI with simulated model inventory / Interface React réelle, inventaire natif simulé.*

**v0.10.3** improves CosyVoice3 acoustic endings and uses memory-mapped Drama 3 experts without a full pinned RAM copy. Generate new takes to use the CosyVoice3 change; existing WAVs remain untouched.

**References and accents:** load, audition, transcribe and reuse a reference audio file directly in **Dubbing**, without assigning a character. Compatible engines accept French accent instructions (France, Quebec, Belgium or Switzerland); adherence varies, and a French reference remains preferable. [Guide and screenshots](docs/VOICE-REFERENCES-AND-ACCENTS.md).

![Direct reference import](docs/screenshots/reference-file-accent.png)

*Actual React UI with simulated native reference import / Interface React réelle, import natif simulé.*

**v0.10.2 — Disk space before Drama 3 installation.** The model card shows the storage folder, available capacity and a conservative budget for missing weights, dependency archives and extraction. Installation is blocked when capacity is insufficient or cannot be checked; the native task checks again before any dependency download. [Installation](docs/FISH-DRAMA-3.md) · [Voice endings and timing](docs/DUBBING-PLACEMENT.md).

![Drama 3 storage preflight](docs/screenshots/drama3-space.png)

*Real React UI with simulated storage capacity / Interface React réelle, capacité simulée.*

**v0.10.1 — Volume directly on the timeline.** Select a range on any audio track to adjust its 0–200% gain, mute/unmute or restore 100% in the timeline. Changes autosave, support undo and keep the advanced Audio editor available. The Fish Audio Drama 3 card now includes its **Install Drama 3 FP8** button, with no separate installation card. [Audio regions](docs/AUDIO-REGIONS.md) · [Drama 3 installation](docs/FISH-DRAMA-3.md).

![Timeline volume](docs/screenshots/timeline-volume.png)

*Actual React UI with synthetic demo audio and simulated native inventory.*

A local desktop workspace for preparing video dubbing: review bilingual subtitles, navigate dialogue by dialogue, and keep displayed text separate from voice pronunciation text.

Built with **Tauri 2, React, TypeScript and Rust**. English and French interface. Dark and light themes.

**v0.9.0 — Local lip retouching and audio range transfers.** MuseTalk 1.5 generates mouth images from a selected dubbed take, using an explicit CUDA GPU, FP16 UNet and FP32 VAE. Frame the full face and blend only the chosen mouth region; compare variants before activation. Anime support is experimental. Choose both the voice-reference source track and the track to replace in the dubbing mix. Copy, move or swap ranges between original/stem tracks, with independent transferred-range gain and undo. [Lip retouching](docs/LIP-INPAINTING.md) · [Audio transfers](docs/AUDIO-TRANSFERS.md) · [Timing analysis](docs/LIP-ALIGNMENT.md).

**v0.10.0 — Fish Audio Drama 3 generation.** A separate FP8 engine keeps routed experts in system RAM, uses up to 4 GiB of GPU expert cache and loads the FP32 codec separately. Profile for NVIDIA 16 GB VRAM + 64 GB RAM, exact reference transcript, moods, seed, independent takes and the existing timing/mix/MKV tools. About 40.1 GB of model downloads; 46 GiB available RAM and 12 GiB free VRAM required. Full-model RTX speed and French quality are not measured on the development host. [Installation and limits](docs/FISH-DRAMA-3.md).

![Drama 3 generation](docs/screenshots/drama3-generation.png)

*Actual React UI with simulated CUDA inventory and generation completion; separate real CPU diagnostics exercise FP8 expert offload, the cache and a tiny autoregressive model.*

![Lip retouch panel](docs/screenshots/inpaint-region.png)

*React/Chrome interface with synthetic video and simulated native model inventory; this screenshot is not an RTX inference benchmark. See validation for the separate real neural CPU diagnostic.*

**Local reference transcription and corrected Fish help.** Whisper small Q5_1 transcribes Japanese, French and the other available languages. The editable transcript is saved with the character reference. The 181 MiB model downloads on first use and runs on CPU to leave VRAM for dubbing. [Reference guide](docs/REFERENCE-TRANSCRIPTION.md).

CosyVoice3, Fish S2 FP8/GGUF and Qwen3-TTS GGUF remain available. [Models and GPU profiles](docs/PHASE-6.md) · [Validation and limits](VALIDATION.md).

![Automatic reference transcription](docs/screenshots/reference-transcription.png)

*Actual React browser UI with a simulated reference and transcription result. Separate native checks transcribe real Japanese speech. These are not RTX performance measurements.*

[Windows downloads](https://github.com/jontechlabs/ai-dubbing-studio/releases/tag/v0.20.1) · [User guide](docs/GETTING-STARTED.md) · [Build instructions](docs/BUILDING.md) · [Français](README.fr.md)

![Studio with bilingual dialogue, video preview, text editor and timeline](docs/screenshots/studio.png)

*Actual French React interface running in the browser preview with the bundled synthetic example. This is not a captured Windows Tauri window. The example has synthetic sound and does not contain generated dubbing.*

## Changes in 0.4.2

Audio regions with independent silence and volume, timeline range selection, fast global/track commands and edited WAV export for separated tracks. Model settings show the folder's file size and a refresh control. [Audio region guide (French)](docs/AUDIO-REGIONS.md) · [Storage and variants](docs/MODELS-AND-STORAGE.md).

## Windows downloads

| Package | Purpose |
| --- | --- |
| [Windows x64 setup](https://github.com/jontechlabs/ai-dubbing-studio/releases/download/v0.20.1/AI-Dubbing-Studio-0.20.1-Setup.exe) | NSIS installer for the current user, with English/French installer interface |
| [Portable ZIP](https://github.com/jontechlabs/ai-dubbing-studio/releases/download/v0.20.1/AI-Dubbing-Studio-Windows-Portable.zip) | Extract the whole folder and launch `AI Dubbing Studio.exe` |
| [SHA-256 checksums](https://github.com/jontechlabs/ai-dubbing-studio/releases/download/v0.20.1/SHA256SUMS.txt) | Verify the setup and ZIP downloads |

Target: **Windows 10/11 x64**, with **Microsoft Edge WebView2 Runtime**. FFmpeg and FFprobe are included. Python, CUDA and AI model downloads are not required for editing and playback. Installation may need Internet access if WebView2 is missing; local project editing does not require a cloud account.

These are **unsigned development builds**. Smart App Control blocked an earlier Phase 1 executable on the development machine. The current Windows GUI and installation workflow are **not fully qualified**. This release is a prerelease. See [validation evidence and limits](VALIDATION.md).

## Available in Phases 1–7

- Import MKV, MP4, MOV, AVI and WebM; inspect streams with FFprobe and choose an audio track.
- Copy the original into a portable project folder; create an H.264/AAC preview proxy when required.
- Import/export UTF-8 SRT, including multiline subtitles. Choose embedded text subtitle tracks (SRT/ASS/SSA and compatible formats) from the video as original or translated subtitles; bitmap tracks require OCR.
- Match source and translated cues conservatively using timings; flag ambiguous matches for review.
- Browse a virtualized dialogue list; select a line to seek the video and highlight its timeline entries.
- Edit source subtitles, translated subtitles and independent TTS pronunciation overrides.
- Play or loop a line with configurable padding; use volume, fullscreen, zoom and transport shortcuts.
- Inspect audio waveforms computed from the chosen original track and separated stems, with local cache, progress and cancellation.
- Identify anonymous voice groups locally with Silero VAD and 3D-Speaker CAMPPlus over existing subtitle intervals. Review/apply proposals, rename characters and correct individual or range assignments.
- Import or extract multiple voice references per character; edit their transcripts and default reference.
- Install speaker identification, CosyVoice3 RL, Fish S2 FP8/GGUF and Qwen3-TTS GGUF from Models. Generate, compare, select and review individual dubbing takes with a chosen engine and GPU.
- Toggle audio mute/solo and subtitle visibility directly from the timeline; preserve player subtitle preferences.
- Optionally synchronize an imported SRT against the other SRT automatically; ambiguous matches preserve the imported file.
- Separate speech/music/effects locally using Bandit v2 Multilingual; install an isolated Python runtime and verified model from Audio. Choose CPU or a detected NVIDIA CUDA device.
- Mix original, dubbed voices and stem tracks with persistent mute, solo, gain and regions; listen with the video and export MKV or individual WAV takes. Pause/resume/cancel and retry separation jobs.
- Prepare a 720p/30 fps preview with frequent keyframes, without upscaling low-resolution media. Subtitle timeline blocks stay stable during playback, including the 6,000-dialogue test.
- Set a Windows GPU rendering preference and inspect playback resolution/dropped-frame counters.
- Check for updates automatically or manually, download a signature-verified package, then install/restart from Settings.
- Edit start/end timecodes for either SRT or both; drag cue blocks, resize their edges, snap with Shift, and adjust track height.
- Split at the playhead or merge with the next line. Changes are included in SRT exports and can be undone.
- Preview automatic SRT-to-SRT synchronization with offset/drift estimation and one-to-many matches; choose either reference and apply explicitly. Ambiguous proposals are refused.
- Autosave, previous-version backup and interrupted-save recovery; undo/redo during the current session.
- Track real import jobs, progress and logs; cancel, retry and identify interrupted jobs after a restart. Creation opens Processing automatically, and the player keeps a loading animation until the import and first-frame preparation finish.
- Switch French/English and dark/light themes; export local diagnostic information.

Automatic synchronization compares timing patterns; it does not perform speech recognition or semantic translation matching. Unmatched cues keep their original timings. Different video edits may need manual correction. See the [Phase 2 guide](docs/PHASE-2.md). Synchronized dubbing and MKV export are available in [Phase 7](docs/PHASE-7.md).

![Automatic bilingual subtitle synchronization preview](docs/screenshots/alignment.png)

*Actual French browser preview using generated test SRTs with a 2.3-second offset; timings are inspected before application.*

## Phase 3, GPU and updates

Read the [Phase 3 guide](docs/PHASE-3.md) for runtime/model installation, GPU preferences, smooth preview, mixer and in-app updates. Version 0.3.0 must first be installed manually when coming from 0.2.x; subsequent signed releases can update through the interface. A portable package uses the same update installer, which installs a current-user application.

![Audio separation and track mixer](docs/screenshots/audio.png)

![GPU preference and verified update installation](docs/screenshots/updates.png)

*Actual React interface in browser tests with simulated native IPC, GPU names and a future update scenario. These are not native Tauri captures. Bandit and CosyVoice3 have separate real Windows CPU inference checks.*

![Final Bandit device check with a bounded wait](docs/screenshots/bandit-check.png)

*Browser test of the actual processing interface with simulated native job events. The model download is complete; device checking has its own indeterminate progress.*

## Characters, models and subtitle controls

Read the [Phase 4 guide](docs/PHASE-4.md). Speaker identification proposes anonymous groups from the speech in existing subtitle intervals; users supply character names and review uncertain matches. The CPU model is trained on English VoxCeleb and has not been qualified on full multilingual films. Voice grouping does not synthesize dubbing.

![Character manager](docs/screenshots/characters.png)

![Voice references and transcript editing](docs/screenshots/references.png)

![Model installation and future engine preference](docs/screenshots/models.png)

![Timeline mute/solo and subtitle visibility controls](docs/screenshots/track-controls.png)

*Actual React UI in browser tests. The character/model/reference screenshots use simulated native results and a synthetic audio stream. Separate real Windows ONNX inference grouped two test voices and kept their repetitions together; it does not establish accuracy on real film soundtracks. Profile/reference preferences use project format 3; older app versions refuse that format.*

## First project

1. Launch the app, choose **Import**, and select a video.
2. Set the project name, source/target languages and audio stream.
3. Choose a parent folder. The desktop app creates `Name.dubproject` and copies the video.
4. Use **Original SRT** and/or **Translated SRT** in the dialogue column. Choose an external file or a text subtitle track detected in the video.
5. Select a dialogue, review the scene, and edit its subtitle or pronunciation text.
6. Reopen the `.dubproject` folder using **Open project**. Move or back up the entire folder to preserve its media.

Use **Explore the example** to try the bundled synthetic video. See the [user guide](docs/GETTING-STARTED.md) for shortcuts, recovery and troubleshooting.

![Welcome screen with import and example actions](docs/screenshots/welcome.png)

*Welcome screen captured in the French browser preview. Screenshots use the dark theme.*

## Local data

Media processing uses local FFmpeg/FFprobe processes. This version has no cloud provider, account system or telemetry implementation. Original input files are preserved; imported copies and proxies stay inside the project directory.

Projects use JSON, stable IDs, relative asset paths and integer millisecond timings. Existing format 1 projects open normally. Adding separated audio tracks upgrades that project to format 2; older app versions refuse format 2. The dubbing bus upgrades projects to format 6; formats 1–5 remain readable. Older versions reject format 6. Unknown formats are rejected without rewriting the file. Autosave uses atomic writes and recovery snapshots. Editing one project simultaneously in multiple app instances is not supported.

The browser preview uses IndexedDB to store projects and video blobs on the current device. It does not run FFprobe or create native portable project folders. Browser JSON export does not include the video blob. Diagnostics may contain local paths and FFmpeg arguments; review an exported report before sharing it.

## Development

Install Node.js 24, pnpm 11.25.0, Rust stable and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Windows builds need MSVC build tools, a Windows SDK and WebView2.

```powershell
git clone https://github.com/jontechlabs/ai-dubbing-studio.git
cd ai-dubbing-studio
pnpm install --frozen-lockfile
powershell -NoProfile -File scripts/prepare-ffmpeg.ps1
powershell -NoProfile -File scripts/prepare-prosody.ps1
pnpm desktop
```

Large FFmpeg executables are excluded from Git. The preparation script verifies the pinned archive SHA-256 before copying them.

```powershell
pnpm desktop:build
powershell -NoProfile -File scripts/package-windows.ps1
```

The packaging script produces setup, portable ZIP and checksums in `artifacts/`. See [build instructions](docs/BUILDING.md) for preview, tests, packaging options and platform limits.

## Architecture

| Area | Responsibility |
| --- | --- |
| `src/components` | Player, dialogue list, text editor and timeline |
| `src/hooks` | Project state, serialized autosave, playback and shortcuts |
| `src/domain` | Project contracts, subtitle/time calculations and future provider interfaces |
| `src/services/bridge.ts` | Desktop IPC boundary and browser-preview adapter |
| `src-tauri/src` | Project storage/recovery, FFprobe, FFmpeg import/proxies, subtitles and jobs |
| `resources` / `schemas` | Toolchain pins and reserved model/worker contracts |

Processing commands use structured arguments rather than a shell. Project-relative paths are validated, and desktop media access is scoped to the opened project. Future provider contracts keep model runtimes outside the UI. `resources/models.json` contains the pinned Bandit model; no TTS model is integrated yet.

See [architecture and persistence](docs/ARCHITECTURE.md).

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Desktop foundation, media import, persistence, subtitle review, simple timeline | Implemented; development preview |
| 2 | Waveforms, timecode editing, subtitle movement, split/merge, automatic SRT synchronization | Implemented; development preview |
| 3 | Bandit speech/music/SFX separation and audio track management | Implemented; CPU validated, CUDA unqualified |
| 4 | Characters, voice references, local AI speaker grouping and dialogue assignment | Implemented; proposals require review |
| 5 | First TTS provider, per-line generation, multiple takes and review | Implemented; CosyVoice3 CPU inference validated |
| 6 | Additional TTS providers and model manager | Implemented; Fish/Qwen GGUF and Fish FP8, RTX validation pending |
| 7 | Final mix export and MKV packaging | Implemented; simultaneous multi-target editing remains outside the current scope |

Local model installation/repair, storage migration, voice cloning and per-line speech generation are implemented. Synchronized mixing and MKV export are implemented. Placement, manual duration and mood settings use project format 7, readable with v0.7.3 or later. Simultaneous editing of several target languages remains to be integrated.

## Validation

The suites contain **49 TypeScript tests, 62 Rust/Linux tests (61 Windows), 49 Chrome scenarios and 25 Python worker tests**: 185 locally, 184 on Windows. The frontend build, ESLint, Prettier, Rust formatting and Clippy are also checked. Real Windows inference covers CosyVoice3, Qwen GGUF, Fish GGUF and a limited-token Fish FP8 core run on CPU. Browser scenarios simulate native IPC; actual RTX generation and the full native GUI workflow remain unqualified here. See [VALIDATION.md](VALIDATION.md) for evidence and limits.

The earlier [v0.1.1 clean Windows run](https://github.com/jontechlabs/ai-dubbing-studio/actions/runs/38362204358) passed its checks and packaging. Current runs are available under [Actions](https://github.com/jontechlabs/ai-dubbing-studio/actions).

Final Windows GUI validation remains pending following the local execution block on an earlier unsigned build. Linux/macOS GUI builds are not qualified. See [VALIDATION.md](VALIDATION.md) for the exact scope.

## Dependencies and licensing

Windows packages bundle the independent Gyan.dev FFmpeg/FFprobe 9.0.2 essentials programs under GPLv3. Their license is included as `binaries/FFMPEG-LICENSE.txt`. See [third-party notices](THIRD-PARTY-NOTICES.txt), the [upstream build description](docs/third-party/FFMPEG-BUILD.txt) and [Gyan build/source references](https://www.gyan.dev/ffmpeg/builds/). Dependencies retain their own licenses; resolved versions are in `pnpm-lock.yaml` and `Cargo.lock`.

Bandit model code is vendored unmodified from the official Apache-2.0 repository at a pinned revision; weights are downloaded from Zenodo under CC BY-SA 4.0 and are not bundled. The inference dependency lock is included.

No project-wide license has been selected. The synthetic example contains no third-party film, voice reference or model weights.
