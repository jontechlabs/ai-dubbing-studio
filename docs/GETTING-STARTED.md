# Getting started

## Install or extract

Get the Windows x64 setup or portable ZIP from [v0.1.1 releases](https://github.com/jontechlabs/ai-dubbing-studio/releases/tag/v0.1.1). These are unsigned development builds; the final native GUI is not fully qualified. See [validation](../VALIDATION.md).

- **Setup:** run the NSIS installer. It installs for the current user and provides French/English language selection.
- **Portable:** extract the entire ZIP, then run `AI Dubbing Studio.exe` inside the extracted folder. Keep `binaries/` and `demo/` beside the executable. The app uses local application data for job records; “portable” describes the executable package, not a zero-footprint mode.

WebView2 Runtime must be available. FFmpeg/FFprobe are bundled. No AI runtime or model is needed for this release.

To verify a download in PowerShell, compare its value with the release's `SHA256SUMS.txt`:

```powershell
Get-FileHash .\AI-Dubbing-Studio-0.1.1-Setup.exe -Algorithm SHA256
Get-FileHash .\AI-Dubbing-Studio-Windows-Portable.zip -Algorithm SHA256
```

## Import and edit

Choose **Import** and a video file. Set a project name, source and target languages, and select the audio stream shown by FFprobe. Choose a writable parent folder. The app creates a `.dubproject` folder and copies the source, so allow space for both the original copy and a possible proxy.

The import job creates a preview proxy for incompatible media or selected/multiple audio tracks. Progress, failure details, cancellation and retry are available in the jobs view. Wait for import to finish before reviewing playback.

Use **Original SRT** / **Translated SRT** in the dialogue panel. Files must be UTF-8 SRT; CRLF, BOM and multiline cue text are accepted. Embedded bitmap subtitle streams are detected but are not OCR-converted. Phase 1 does not automatically transcribe, translate or extract embedded subtitle text.

Select a dialogue to seek its scene. The **Text** tab edits the displayed source/translation. The **Pronunciation** tab stores a separate voice text override for future TTS. Changing a translated subtitle does not silently change an existing override. Voice-generation controls remain unavailable in Phase 1.

Use the player and timeline to review the scene. **Play this line** uses configurable padding before/after the cue. Enable looping for repeated review. Settings also contain interface language and theme.

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

The export dialog provides source/translated SRT and diagnostics. A finished dubbed soundtrack, mix or MKV is not available in this phase.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Windows blocks the executable | The release is unsigned and may be blocked by Smart App Control or other execution policies. Signing and native qualification remain outstanding. |
| FFmpeg or FFprobe unavailable | Portable resource folders must remain beside the executable; source builds require the preparation script or matching tools on PATH. |
| Video cannot play | Check the import job and proxy result; retry a failed job. Final WebView2 playback still needs native qualification. |
| Subtitle pairs show warnings | Only unambiguous one-to-one timing matches are paired automatically. Review unmatched cues; manual timing/alignment is planned. |
| Save fails | Confirm the project folder is writable and has space. Avoid simultaneous editing in multiple instances. |
| A browser project is missing | Browser data belongs to that browser/origin's IndexedDB. Clearing site data removes it. Desktop project folders are separate. |

Diagnostics may contain local paths. Review them before sharing an issue report.
