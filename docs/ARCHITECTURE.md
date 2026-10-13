# Architecture and persistence

The React UI calls `src/services/bridge.ts`. In desktop mode, that adapter invokes Tauri Rust commands. In browser-preview mode, it uses IndexedDB and browser media playback. Components do not build FFmpeg command lines.

```mermaid
flowchart LR
  UI[React studio] --> Bridge[Typed service bridge]
  Bridge --> IPC[Tauri IPC]
  IPC --> Project[Project storage and recovery]
  IPC --> Jobs[Serialized media jobs]
  Jobs --> Tools[Local FFprobe and FFmpeg]
  Project --> Folder[Portable project folder]
  Jobs --> Folder
  Bridge --> Preview[Browser IndexedDB adapter]
```

## Project structure

```text
Example.dubproject/
  project.json
  media/                 imported original copy
  cache/                 playback proxies and waveform peak caches
  recovery/
    previous.json        previous valid save
    pending.json         transient interrupted-save snapshot
```

`project.json` contains format/app versions, project ID and revision, timestamps, languages, media metadata, source/target cues and stable dialogue associations. Cue timings are integer milliseconds. Asset paths are relative and validated against traversal. Source/target cue documents and dialogues are separate so subtitle pairing can preserve their identities.

A dialogue has source and target cue references, a nullable independent `ttsText`, warnings, generation-selection IDs and a nullable character ID. Character/generation collections and provider interfaces reserve future functionality. They do not implement AI generation in Phase 2.

## Saving and recovery

Frontend edits are debounced and saves are serialized. Revision expectations protect the current session from stale updates. Rust validates the project, writes a recovery snapshot, and replaces `project.json` atomically. The previous valid file is retained in `recovery/previous.json`.

Loading checks the format and structure, considers a newer valid pending save for the same project, and can recover from the previous snapshot when required. Unknown format versions are refused without rewriting them. Undo/redo uses bounded in-memory snapshots and is not preserved between sessions. Cross-process locking is not implemented.

## Media jobs

An import request records the selected audio stream and project identity. A single-permit queue serializes media jobs. FFprobe discovers streams; FFmpeg prepares H.264/AAC stereo preview proxies where needed. Commands use structured arguments, a local file/pipe protocol whitelist, cancellation and subprocess cleanup.

The input is copied to a unique asset filename. Existing project assets are not overwritten by a failed import; incomplete outputs owned by the failed job are cleaned up. Job status, progress, logs and restart interruption records are stored in local app data. Retry creates a new attempt.

## Subtitles and playback

UTF-8 SRT parsing handles BOM, CRLF and multiline text. Automatic bilingual pairing only joins unique one-to-one timing matches within the tolerance; ambiguity remains separate and flagged. Later import reconciliation preserves dialogue IDs, TTS overrides and selected generations where associations remain identifiable.

Embedded text tracks are selected by global FFprobe stream index and extracted from the original project media, rather than the playback proxy. FFmpeg converts them into UTF-8 SRT. The serialized, cancellable extraction job validates the track, refuses bitmap streams, and uses the same subtitle persistence/reconciliation path as external SRT imports. It commits only after extraction and parsing succeed.

Video creation opens Processing after enqueueing import. The player distinguishes an unfinished media job from URL resolution/first-frame loading, buffering, and playback errors. A failed load ends its animation and offers proxy preparation.

The dialogue list is virtualized. The player uses the browser/WebView media element; cue selection drives seeking and the simple timeline. Playback state stays separate from persisted project edits. Looping uses configured padding and media duration bounds.

## Future engines

`src/domain/providers.ts` defines reserved provider capabilities, model metadata and TTS requests/results. `schemas/worker-protocol.schema.json` and `schemas/model-manifest.schema.json` are preliminary contracts. The initial model catalogue is empty. Future workers, installers, hardware backends and model runtimes are not present in this release.

## Phase 2 timing and waveform

The timeline renders actual source/target cues rather than the shared dialogue bounds. Pointer edits are previewed in UI state and committed once on release. Timecode edits transform each selected role’s cue group proportionally; split divides text near a grapheme/whitespace boundary and marks review, while merge creates one cue per role with joined multiline text. Existing audio-generation assets remain in the project; their per-line selection is cleared when restructuring invalidates it.

`src/domain/alignment.ts` estimates an affine timing transform from sampled start/end differences, tests monotonic associations (one-to-one or one-to-up-to-three), and refines drift using independent matches. Search is limited to offsets within two minutes and candidate drift between −10% and +10%. At least three matched groups and 60% cue coverage are required; similar competing transforms are refused. These criteria measure timing evidence, not semantic certainty. The UI computes proposals in a Web Worker, shows examples and metrics, then applies only confirmed groups to the reference boundaries; unmatched timings remain untouched. Revision checks reject stale previews. Text/cue IDs and project generation assets are preserved; regrouped dialogue metadata is marked for review. TTS overrides are carried once when old groups are combined.

`src-tauri/src/waveform.rs` decodes the chosen original audio stream through FFmpeg into mono 8 kHz PCM. It preserves the common input timebase and inserts initial silence where needed. A streaming peak accumulator limits the cache to roughly 200,000 bins, with a minimum bin width of 20 ms. The key includes path, file size/modification time, stream and cache version. Processing is serialized with other media jobs but does not block project editing. Cancellation drops the subprocess; failed/partial computations do not become cache entries. The canvas draws only the visible viewport and normalizes display amplitude without changing stored peaks. Browser preview uses Web Audio instead of FFmpeg.
