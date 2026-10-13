use crate::{
    domain::{io_error, Project},
    media, project, subtitles,
};
use std::path::Path;

pub fn run(root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(io_error)?;
    let exe = std::env::current_exe().map_err(io_error)?;
    let binaries = exe.parent().ok_or("INVALID_PATH")?.join("binaries");
    let source = root.join("native-smoke.mkv");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(io_error)?;
    let info = runtime.block_on(async {
        let ffmpeg = binaries.join(format!("ffmpeg{}", std::env::consts::EXE_SUFFIX));
        let ffprobe = binaries.join(format!("ffprobe{}", std::env::consts::EXE_SUFFIX));
        let status = media::command(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=size=320x180:rate=24",
                "-t",
                "0.5",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&source)
            .status()
            .await
            .map_err(io_error)?;
        if !status.success() {
            return Err("PROCESS_FAILED".into());
        }
        media::probe_executable(&ffprobe, &source).await
    })?;
    let project_root = project::create_root(root, &format!("Smoke-{}", crate::domain::id()))?;
    let mut p = Project::new("Native smoke".into(), "ja".into(), "fr".into());
    p.source_cues = subtitles::parse_srt("1\n00:00:00,000 --> 00:00:00,400\nこんにちは")?;
    p.dialogues = subtitles::align(&p.source_cues, &[]);
    p.dialogues[0].tts_text = Some("Zutte !".into());
    project::save(&project_root, &p)?;
    let restored = project::load(&project_root)?;
    let report = serde_json::json!({"ok": true, "ffprobe": info, "projectReload": restored.id == p.id, "ttsText": restored.dialogues[0].tts_text, "unicodeText": restored.source_cues[0].text });
    project::atomic_write(
        &root.join("native-smoke-result.json"),
        &serde_json::to_vec_pretty(&report).map_err(io_error)?,
    )
}
