use crate::{domain::io_error, domain::Project, jobs, media, project, Core};
use std::path::Path;
use std::sync::{atomic::Ordering, Arc};

pub async fn extract(executable: &Path, input: &Path, index: u32) -> Result<String, String> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(180),
        media::command(executable)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-copyts",
                "-start_at_zero",
                "-protocol_whitelist",
                "file,pipe",
                "-i",
            ])
            .arg(input)
            .args([
                "-map",
                &format!("0:{index}"),
                "-c:s",
                "srt",
                "-f",
                "srt",
                "pipe:1",
            ])
            .output(),
    )
    .await
    .map_err(|_| "SUBTITLE_EXTRACTION_FAILED: timeout".to_owned())?
    .map_err(io_error)?;
    if !output.status.success() {
        return Err(format!(
            "SUBTITLE_EXTRACTION_FAILED: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let text = String::from_utf8(output.stdout).map_err(|_| "INVALID_SRT".to_owned())?;
    if text.trim().is_empty() {
        return Err("EMPTY_SUBTITLE_TRACK".into());
    }
    Ok(text)
}

pub async fn import<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    index: u32,
    role: &str,
) -> Result<Project, String> {
    if !["source", "target"].contains(&role) {
        return Err("INVALID_PROJECT".into());
    }
    let (root, project_id, input) = {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        let asset = s.project.media.as_ref().ok_or("MEDIA_MISSING")?;
        let stream = asset
            .info
            .streams
            .iter()
            .find(|stream| stream.kind == "subtitle" && stream.index == index)
            .ok_or("INVALID_SUBTITLE_TRACK")?;
        if stream.bitmap {
            return Err("BITMAP_SUBTITLES".into());
        }
        (
            s.root.clone(),
            s.project.id.clone(),
            project::asset(&s.root, &asset.path)?,
        )
    };
    let key = jobs::create(&core, &app, "subtitles", project_id.clone(), None);
    jobs::update(&core, &app, &key, |job| job.stage = "extract".into());
    let flag = core
        .jobs
        .lock()
        .map_err(io_error)?
        .get(&key)
        .ok_or("INVALID_PROJECT")?
        .cancel
        .clone();
    let result = async {
        let _permit = tokio::select! {
            _ = jobs::cancelled(&flag) => return Err("CANCELLED".into()),
            permit = core.gate.clone().acquire_owned() => permit.map_err(io_error)?,
        };
        if flag.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        jobs::update(&core, &app, &key, |job| {
            job.status = "running".into();
            job.logs.push(format!(
                "Extract subtitle stream {index} as {role}: {input:?}"
            ));
        });
        let ffmpeg = media::binary(&app, "ffmpeg")?;
        let text = tokio::select! {
            _ = jobs::cancelled(&flag) => return Err("CANCELLED".into()),
            result = extract(&ffmpeg, &input, index) => result?,
        };
        if flag.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        jobs::update(&core, &app, &key, |job| job.stage = "commit".into());
        let mut session = core.session.lock().map_err(io_error)?;
        let s = session.as_mut().ok_or("NO_PROJECT")?;
        if s.root != root || s.project.id != project_id {
            return Err("STALE_REVISION".into());
        }
        s.import_subtitles(&text, role)
    }
    .await;
    jobs::update(&core, &app, &key, |job| match &result {
        Ok(_) => {
            job.status = "succeeded".into();
            job.stage = "done".into();
            job.progress = Some(1.0);
        }
        Err(error) => {
            job.status = if error == "CANCELLED" {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            job.error = Some(error.clone());
        }
    });
    result
}
