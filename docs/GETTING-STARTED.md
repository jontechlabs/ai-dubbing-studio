# Getting started

## Install or extract

Get the Windows x64 setup or portable ZIP from [v0.7.3 releases](https://github.com/jontechlabs/ai-dubbing-studio/releases/tag/v0.7.3). These are development builds without Authenticode; updater signatures are checked separately. The final native GUI is not fully qualified. See [validation](../VALIDATION.md).

- **Setup:** run the NSIS installer. It installs for the current user and provides French/English language selection.
- **Portable:** extract the entire ZIP, then run `AI Dubbing Studio.exe` inside the extracted folder. Keep `binaries/` and `demo/` beside the executable. The app uses local application data for job records; “portable” describes the executable package, not a zero-footprint mode.

WebView2 Runtime must be available. FFmpeg/FFprobe are bundled. No AI runtime or model is needed for editing and playback. Optional Bandit separation installs its runtime/model from Audio.

To verify a download in PowerShell, compare its value with the release's `SHA256SUMS.txt`:

```powershell
Get-FileHash .\AI-Dubbing-Studio-0.7.3-Setup.exe -Algorithm SHA256
Get-FileHash .\AI-Dubbing-Studio-Windows-Portable.zip -Algorithm SHA256
```

## Import and edit

Choose **Import** and a video file. Set a project name, source and target languages, and select the audio stream shown by FFprobe. Choose a writable parent folder. The app creates a `.dubproject` folder and copies the source, so allow space for both the original copy and a possible proxy.

The import job creates a preview proxy for incompatible media or selected/multiple audio tracks. **Processing opens automatically** when creation starts. It shows the current stage, progress, logs, cancellation and retry. Close the panel if desired; the player keeps a loading animation until the job finishes and the first video frame is ready. Progress percentages apply to the displayed stage, not to the whole workflow.

Use **Original SRT** / **Translated SRT** in the dialogue panel. If the video has subtitle tracks, a picker offers an external SRT file or an embedded track identified by its index, language, title and codec. Choose a track and **Use this track**; repeat for the other role. Existing projects use the same picker, with no need to reimport the video.

Text tracks are extracted from the imported original video copy, converted to UTF-8 SRT, and stored inside the project. ASS/SSA advanced formatting is simplified by SRT conversion. Bitmap tracks such as PGS/DVD are listed but cannot be selected; OCR is required and is not provided in this release. You can supply an externally converted SRT instead.

External files must be UTF-8 SRT; CRLF, BOM and multiline cues are accepted. Extraction can be cancelled through Processing; cancellation or conversion failure preserves existing subtitles. No automatic transcription or translation is performed.

Select a dialogue to seek its scene. The **Text** tab edits the displayed source/translation. The **Pronunciation** tab stores a separate voice text override. Changing a translated subtitle does not silently change an existing override. **Dub** on each dialogue opens CosyVoice3, Fish S2 FP8/GGUF or Qwen3-TTS GGUF generation. See [Phase 6](PHASE-6.md) for model installation, GPU choice and reference requirements.

For Fish, the reference audio needs a transcript in the language actually spoken. **Characters → Voice references → Transcribe automatically** prepares it locally, with automatic language detection or an explicit choice. The same action is available in **Dubbing** for a selected character reference. Review the editable transcript before generating speech. First use downloads a verified 181 MiB Whisper model to the configured model folder; inference uses CPU and does not upload audio. See the [reference guide](REFERENCE-TRANSCRIPTION.md), including the workflow for a current line without an original SRT.

Use the player and timeline to review the scene. **Play this line** uses configurable padding before/after the cue. Enable looping for repeated review. Settings also contain interface language and theme.

## Timing and automatic synchronization

See the [Phase 2 guide](PHASE-2.md) for timecode editing, waveform, drag/resize, split/merge and automatic synchronization. Use **Analyze → Calculate synchronization** after importing both SRTs, inspect the proposal, then apply it. The selected reference keeps its timings. This operation can be undone with Ctrl+Z.

## Separation, performance and updates

See the [Phase 3 guide](PHASE-3.md). Audio contains Bandit installation, device selection, separation and mixer. Settings contains GPU preference, playback counters and signed updates. Installing 0.3.0 manually enables future in-app updates.

See the [Phase 4 guide](PHASE-4.md) to install the local speaker model, apply/correct anonymous voice proposals, create characters and voice references. The translated SRT picker offers optional automatic synchronization. Timeline speaker/S buttons control audio and eye buttons control subtitle preview. Profiles and saved preview preferences use project format 3, refused by older app versions.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Space | Play/pause |
| J | Seek backward two seconds |
| K | Pause |
| L | Play, then increase playback speed |
| O | Play the selected line's original audio |
| Ctrl+S | Save |
| Ctrl+Z / Ctrl+Y | Undo/redo in the current session |

Transport shortcuts are ignored while typing or while a dialog is active.

## Save, reopen and export

Changes autosave; watch the save indicator. If saving fails, keep the project open and retry after resolving the filesystem problem. Reopen a project by selecting its `.dubproject` directory with **Open project**.

Back up or move the **whole folder**, including `media/`, `cache/` and `recovery/`. `project.json` alone does not contain the video. Recovery snapshots allow an interrupted save to be restored; undo history belongs to the current session.

Use **Prepare dubbing mix**, then Play to listen to selected takes with the video. Audio controls dubbing/music/effects volumes, mutes, solos and regions. **Export → Export MKV** copies the original video and writes the current mix, with optional original audio and selectable source/translated SRT tracks. The player monitoring volume does not affect export. See the [Phase 7 guide](PHASE-7.md).

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Windows blocks the executable | The release is unsigned and may be blocked by Smart App Control or other execution policies. Signing and native qualification remain outstanding. |
| FFmpeg or FFprobe unavailable | Portable resource folders must remain beside the executable; source builds require the preparation script or matching tools on PATH. |
| Video cannot play | Check the import job and proxy result; retry a failed job. Final WebView2 playback still needs native qualification. |
| Subtitle pairs show warnings | Import pairs only unique close timings. Use Analyze to estimate global synchronization, then review unmatched cues manually. Timing-only matching cannot verify translation meaning or align speech. |
| Save fails | Confirm the project folder is writable and has space. Avoid simultaneous editing in multiple instances. |
| A browser project is missing | Browser data belongs to that browser/origin's IndexedDB. Clearing site data removes it. Desktop project folders are separate. |

Diagnostics may contain local paths. Review them before sharing an issue report.

## Dossier des modèles et variantes (0.4.2)

Consultez le [guide du stockage, des pistes et des profils GGUF/FP8](MODELS-AND-STORAGE.md). Le haut-parleur remplace M : allumé = activé, barré = coupé. Les profils TTS sont des préférences préparatoires pour les phases 5 et 6.

## Audio regions (0.4.2)

Shift-drag on an audio timeline track to edit a range, or open Audio → Audio regions. Track and region volumes are independent. Quick commands can silence everything or bypass regions temporarily. See the [illustrated audio guide](AUDIO-REGIONS.md). Model storage shows the sum of file sizes; Refresh recalculates it without blocking the interface.

## Voice placement, duration and delivery (0.7.3)

Drag a selected dubbing clip to align its onset. Resize its right edge to lengthen or shorten it while preserving pitch. The Dubbing panel also provides numeric offset/duration controls and reset buttons. Before generating a new take, choose its mood on CosyVoice3 or Fish S2. See [placement and duration](DUBBING-PLACEMENT.md) and [moods](VOICE-MOODS.md). Both edits use project format 7.
