//! Local character metadata. Gender is an explicit manual label, never inferred.
use crate::{
    domain::{io_error, Project},
    project,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Default for Rect {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        }
    }
}
impl Rect {
    pub fn validate(&self) -> Result<(), String> {
        if ![self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            || self.x < 0.0
            || self.y < 0.0
            || self.width <= 0.0
            || self.height <= 0.0
            || self.x + self.width > 1.000001
            || self.y + self.height > 1.000001
        {
            return Err("CHARACTER_PORTRAIT_INVALID".into());
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Portrait {
    pub path: String,
    pub source_path: String,
    pub at_ms: u64,
    pub line_id: String,
    pub crop: Rect,
    pub difference_hash: String,
    pub colors: Vec<f64>,
    pub confirmed: bool,
}
impl Portrait {
    pub fn validate(&self) -> Result<(), String> {
        crate::domain::valid_relative(&self.path)?;
        if !self.path.starts_with("characters/")
            || !self.path.ends_with(".png")
            || self.source_path.is_empty()
            || self.line_id.is_empty()
            || self.difference_hash.len() != 16
            || !self
                .difference_hash
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
            || self.colors.len() != 48
            || self
                .colors
                .iter()
                .any(|n| !n.is_finite() || !(0.0..=1.0).contains(n))
        {
            return Err("CHARACTER_PORTRAIT_INVALID".into());
        }
        self.crop.validate()
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocalRegister {
    pub median_hz: f64,
    pub confidence: f64,
    pub analyzed_ms: u64,
}
impl VocalRegister {
    fn validate(&self) -> Result<(), String> {
        if !self.median_hz.is_finite()
            || !(50.0..=700.0).contains(&self.median_hz)
            || !self.confidence.is_finite()
            || !(0.0..=1.0).contains(&self.confidence)
            || !(100..=20000).contains(&self.analyzed_ms)
        {
            return Err("INVALID_CHARACTER".into());
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gender: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice_library: Option<crate::voice_library::Library>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temporary_name: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portrait: Option<Portrait>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vocal_register: Option<VocalRegister>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Scope {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference_character_id: Option<String>,
    pub replace_assigned: bool,
}
pub fn audio_snapshot(p: &Project, reference_character_id: Option<&str>) -> serde_json::Value {
    serde_json::json!({"tracks":p.tracks,"patches":p.generations.iter().filter(|g| matches!(g["kind"].as_str(),Some("audioPatch"|"audioEffects"))).collect::<Vec<_>>(),"references":p.characters.iter().filter(|c|Some(c.id.as_str())==reference_character_id).map(|c|serde_json::json!({"id":c.id,"references":c.references})).collect::<Vec<_>>()})
}
pub fn validate(p: &Project) -> Result<(), String> {
    if !p.character_profiles.is_empty() && p.format_version < 20 {
        return Err("INVALID_CHARACTER".into());
    }
    for (id, profile) in &p.character_profiles {
        if !p.characters.iter().any(|c| &c.id == id)
            || profile
                .gender
                .as_deref()
                .is_some_and(|v| !["unspecified", "man", "woman", "other"].contains(&v))
        {
            return Err("INVALID_CHARACTER".into());
        }
        if let Some(portrait) = &profile.portrait {
            portrait.validate()?;
        }
        if let Some(v) = &profile.vocal_register {
            v.validate()?;
        }
    }
    if let Some(a) = &p.speaker_analysis {
        use std::collections::HashSet;
        let lines = a
            .lines
            .iter()
            .map(|l| l.id.as_str())
            .collect::<HashSet<_>>();
        let speakers = a.clusters.iter().map(|c| c.speaker).collect::<HashSet<_>>();
        let assignments = a
            .assignments
            .iter()
            .map(|v| v.dialogue_id.as_str())
            .collect::<HashSet<_>>();
        if lines.len() != a.lines.len()
            || speakers.len() != a.clusters.len()
            || a.clusters.len() > 32
            || assignments != lines
            || a.assignments.len() != a.lines.len()
            || a.lines
                .iter()
                .any(|l| l.id.is_empty() || l.end_ms <= l.start_ms)
            || a.assignments.iter().any(|v| {
                v.speaker.is_some_and(|s| !speakers.contains(&s))
                    || v.similarity
                        .is_some_and(|n| !n.is_finite() || !(-1.0..=1.0).contains(&n))
            })
        {
            return Err("INVALID_CHARACTER".into());
        }
        for c in &a.clusters {
            if c.speaker >= 32
                || !lines.contains(c.reference_dialogue_id.as_str())
                || !c.reference_path.ends_with(".wav")
            {
                return Err("INVALID_CHARACTER".into());
            }
            if let Some(portrait) = &c.portrait {
                portrait.validate()?;
            }
            if let Some(v) = &c.vocal_register {
                v.validate()?;
            }
            if c.character_id
                .as_ref()
                .is_some_and(|id| !p.characters.iter().any(|c| &c.id == id))
            {
                return Err("INVALID_CHARACTER".into());
            }
        }
        if let Some(s) = &a.scope {
            let valid_range = match (s.start_ms, s.end_ms) {
                (None, None) => true,
                (Some(start), Some(end)) => {
                    end > start && a.lines.iter().all(|l| l.start_ms < end && l.end_ms > start)
                }
                _ => false,
            };
            if p.format_version < 20
                || !valid_range
                || s.reference_character_id
                    .as_ref()
                    .is_some_and(|id| !p.characters.iter().any(|c| &c.id == id))
            {
                return Err("INVALID_CHARACTER".into());
            }
        }
        if a.original_assignments.as_ref().is_some_and(|m| {
            m.len() != lines.len() || m.keys().any(|id| !lines.contains(id.as_str()))
        }) {
            return Err("INVALID_CHARACTER".into());
        }
    }
    Ok(())
}
pub fn asset(core: &crate::Core, path: &str) -> Result<String, String> {
    let session = core.session.lock().map_err(io_error)?;
    let s = session.as_ref().ok_or("NO_PROJECT")?;
    let allowed = s
        .project
        .character_profiles
        .values()
        .any(|c| c.portrait.as_ref().is_some_and(|p| p.path == path))
        || s.project.speaker_analysis.as_ref().is_some_and(|a| {
            a.clusters.iter().any(|c| {
                c.reference_path == path || c.portrait.as_ref().is_some_and(|p| p.path == path)
            })
        });
    if !allowed {
        return Err("INVALID_PATH".into());
    }
    let resolved = project::asset(&s.root, path)?;
    if !resolved.is_file() {
        return Err("MEDIA_MISSING".into());
    }
    Ok(resolved.to_string_lossy().into_owned())
}

// Short interactive previews have no queued job, unlike speaker analysis.
// Bound their lifetime and close stdin; do not send them through the job-only runner.
pub(crate) async fn direct_process(
    executable: &std::path::Path,
    args: &[String],
    flag: &std::sync::atomic::AtomicBool,
    limit: std::time::Duration,
) -> Result<(), String> {
    let output = tokio::select! {
        _ = crate::jobs::cancelled(flag) => return Err("CANCELLED".into()),
        result = tokio::time::timeout(limit, crate::media::command(executable)
            .args(args).env("PYTHONUNBUFFERED", "1").env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8:backslashreplace")
            .stdin(std::process::Stdio::null()).output()) => result,
    }
    .map_err(|_| "PROCESS_FAILED: character preview timeout".to_string())?
    .map_err(io_error)?;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some(error) = serde_json::from_str::<serde_json::Value>(line)
            .ok()
            .and_then(|value| value["error"].as_str().map(str::to_owned))
        {
            return Err(error);
        }
    }
    if !output.status.success() {
        let start = output.stderr.len().saturating_sub(4096);
        return Err(format!(
            "PROCESS_FAILED: {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr[start..])
        ));
    }
    Ok(())
}
async fn process<R: tauri::Runtime>(
    core: &std::sync::Arc<crate::Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    executable: &std::path::Path,
    args: &[String],
    flag: &std::sync::atomic::AtomicBool,
) -> Result<(), String> {
    if key.is_empty() {
        direct_process(executable, args, flag, std::time::Duration::from_secs(60)).await
    } else {
        crate::separation::process(core, app, key, executable, args, flag).await
    }
}
async fn frame<R: tauri::Runtime>(
    core: &std::sync::Arc<crate::Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    input: &std::path::Path,
    at_ms: u64,
    output: &std::path::Path,
    flag: &std::sync::atomic::AtomicBool,
) -> Result<(), String> {
    process(
        core,
        app,
        key,
        &crate::media::binary(app, "ffmpeg")?,
        &[
            "-nostdin".into(),
            "-hide_banner".into(),
            "-v".into(),
            "error".into(),
            "-ss".into(),
            format!("{:.3}", at_ms as f64 / 1000.0),
            "-protocol_whitelist".into(),
            "file,pipe".into(),
            "-i".into(),
            input.to_string_lossy().into_owned(),
            "-map".into(),
            "0:v:0".into(),
            "-frames:v".into(),
            "1".into(),
            "-vf".into(),
            "scale=640:640:force_original_aspect_ratio=decrease,setsar=1".into(),
            "-n".into(),
            output.to_string_lossy().into_owned(),
        ],
        flag,
    )
    .await
}
async fn portrait_worker<R: tauri::Runtime>(
    core: &std::sync::Arc<crate::Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    folder: &std::path::Path,
    items: serde_json::Value,
    automatic: bool,
    flag: &std::sync::atomic::AtomicBool,
) -> Result<Vec<Portrait>, String> {
    let output = folder.join("portraits-result.json");
    let request = folder.join("portraits-request.json");
    project::atomic_write(&request,&serde_json::to_vec(&serde_json::json!({"models":crate::speakers::root(core),"auto":automatic,"profile":"auto","items":items,"output":output})).map_err(io_error)?)?;
    process(
        core,
        app,
        key,
        &crate::separation::python(&crate::speakers::root(core)),
        &[
            crate::separation::resources(app)
                .join("character_worker.py")
                .to_string_lossy()
                .into_owned(),
            "--request".into(),
            request.to_string_lossy().into_owned(),
        ],
        flag,
    )
    .await?;
    let result: Vec<Portrait> =
        serde_json::from_slice(&std::fs::read(output).map_err(io_error)?).map_err(io_error)?;
    for portrait in &result {
        portrait.validate()?;
    }
    Ok(result)
}
#[allow(clippy::too_many_arguments)]
pub async fn propose_portraits<R: tauri::Runtime>(
    core: &std::sync::Arc<crate::Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    p: &Project,
    root: &std::path::Path,
    folder: &std::path::Path,
    relative: &str,
    analysis: &mut crate::domain::SpeakerAnalysis,
    flag: &std::sync::atomic::AtomicBool,
) -> Result<(), String> {
    let media = p.media.as_ref().ok_or("MEDIA_MISSING")?;
    if !media.info.streams.iter().any(|s| s.kind == "video") {
        return Ok(());
    }
    let input = project::asset(root, &media.path)?;
    let mut items = vec![];
    crate::jobs::update(core, app, key, |j| {
        j.stage = "characterPortraits".into();
        j.progress = None;
    });
    for cluster in &analysis.clusters {
        let line = analysis
            .lines
            .iter()
            .find(|l| l.id == cluster.reference_dialogue_id)
            .ok_or("SPEAKER_ANALYSIS_FAILED")?;
        let start = line.start_ms.max(
            analysis
                .scope
                .as_ref()
                .and_then(|s| s.start_ms)
                .unwrap_or(0),
        );
        let end = line.end_ms.min(
            analysis
                .scope
                .as_ref()
                .and_then(|s| s.end_ms)
                .unwrap_or(media.info.duration_ms),
        );
        let at_ms = start + (end - start) / 2;
        let file = folder.join(format!("frame-{}.png", cluster.speaker));
        if let Err(error) = frame(core, app, key, &input, at_ms, &file, flag).await {
            if flag.load(std::sync::atomic::Ordering::Relaxed) {
                return Err("CANCELLED".into());
            }
            crate::jobs::update(core, app, key, |j| {
                j.logs.push(format!(
                    "Portrait unavailable for dialogue {}: {error}",
                    line.id
                ))
            });
            continue;
        }
        items.push(serde_json::json!({"input":file,"output":folder.join(format!("portrait-{}.png",cluster.speaker)),"metadata":{"path":format!("{relative}/portrait-{}.png",cluster.speaker),"sourcePath":media.path,"atMs":at_ms,"lineId":line.id}}));
    }
    if !items.is_empty() {
        let portraits = portrait_worker(core, app, key, folder, items.into(), true, flag).await?;
        for portrait in portraits {
            if let Some(cluster) = analysis
                .clusters
                .iter_mut()
                .find(|c| c.reference_dialogue_id == portrait.line_id)
            {
                cluster.portrait = Some(portrait);
            }
        }
    }
    for cluster in &analysis.clusters {
        let _ = std::fs::remove_file(folder.join(format!("frame-{}.png", cluster.speaker)));
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortraitOptions {
    pub character_id: String,
    pub line_id: String,
    pub at_ms: Option<u64>,
    pub crop: Option<Rect>,
}
pub async fn capture_portrait<R: tauri::Runtime>(
    core: std::sync::Arc<crate::Core>,
    app: tauri::AppHandle<R>,
    options: PortraitOptions,
) -> Result<Project, String> {
    if !crate::speakers::installed(&core) {
        return Err("SPEAKER_RUNTIME_REQUIRED".into());
    }
    if crate::jobs::active_processing(&core) {
        return Err("BUSY".into());
    }
    let _permit = core.gate.clone().try_acquire_owned().map_err(|_| "BUSY")?;
    let (root, p) = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        (s.root.clone(), s.project.clone())
    };
    let media = p.media.as_ref().ok_or("MEDIA_MISSING")?;
    if !p.characters.iter().any(|c| c.id == options.character_id) {
        return Err("INVALID_CHARACTER".into());
    }
    let line = p
        .dialogues
        .iter()
        .find(|l| l.id == options.line_id)
        .ok_or("NO_DIALOGUES")?;
    let at_ms = options
        .at_ms
        .unwrap_or(line.start_ms + (line.end_ms - line.start_ms) / 2);
    if at_ms >= media.info.duration_ms {
        return Err("CHARACTER_PORTRAIT_INVALID".into());
    }
    if let Some(crop) = &options.crop {
        crop.validate()?;
    }
    project::ensure_directory(&root, "characters")?;
    let relative = format!("characters/portrait-{}", crate::domain::id());
    let folder = root.join(&relative);
    std::fs::create_dir(&folder).map_err(io_error)?;
    let flag = std::sync::atomic::AtomicBool::new(false);
    let input = folder.join("frame.png");
    frame(
        &core,
        &app,
        "",
        &project::asset(&root, &media.path)?,
        at_ms,
        &input,
        &flag,
    )
    .await?;
    let items = serde_json::json!([{"input":input,"output":folder.join("portrait.png"),"crop":options.crop,"metadata":{"path":format!("{relative}/portrait.png"),"sourcePath":media.path,"atMs":at_ms,"lineId":line.id}}]);
    let portrait = portrait_worker(
        &core,
        &app,
        "",
        &folder,
        items,
        options.crop.is_none(),
        &flag,
    )
    .await?
    .into_iter()
    .next()
    .ok_or("CHARACTER_PORTRAIT_INVALID")?;
    let _ = std::fs::remove_file(input);
    let mut guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_mut().ok_or("NO_PROJECT")?;
    if s.root != root || s.project.id != p.id {
        return Err("STALE_REVISION".into());
    }
    let mut next = p.clone();
    next.format_version = next.format_version.max(20);
    next.character_profiles
        .entry(options.character_id)
        .or_default()
        .portrait = Some(portrait);
    let saved = s.replace(next, p.revision)?;
    use tauri::Emitter;
    let _ = app.emit("project-changed", &saved);
    Ok(saved)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceSegment {
    pub character_id: String,
    pub reference_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
}
pub async fn combine_reference<R: tauri::Runtime>(
    core: std::sync::Arc<crate::Core>,
    app: tauri::AppHandle<R>,
    segments: Vec<ReferenceSegment>,
    label: String,
) -> Result<crate::domain::VoiceReference, String> {
    if crate::jobs::active_processing(&core) {
        return Err("BUSY".into());
    }
    if !(1..=16).contains(&segments.len()) || label.trim().is_empty() || label.len() > 400 {
        return Err("INVALID_REFERENCE_RANGE".into());
    }
    let _permit = core.gate.clone().try_acquire_owned().map_err(|_| "BUSY")?;
    let (root, p) = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        (s.root.clone(), s.project.clone())
    };
    let mut total = 0_u64;
    let mut transcript = vec![];
    let mut complete = true;
    let mut args = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-v".into(),
        "error".into(),
    ];
    let mut filters = vec![];
    for (i, segment) in segments.iter().enumerate() {
        let reference = p
            .voice_reference(Some(&segment.character_id), &segment.reference_id)
            .ok_or("INVALID_REFERENCE_AUDIO")?;
        if segment.end_ms > reference.duration_ms
            || segment.end_ms <= segment.start_ms
            || segment.end_ms - segment.start_ms < 100
        {
            return Err("INVALID_REFERENCE_RANGE".into());
        }
        total = total
            .checked_add(segment.end_ms - segment.start_ms)
            .ok_or("INVALID_REFERENCE_RANGE")?;
        if total > 20000 {
            return Err("INVALID_REFERENCE_RANGE".into());
        }
        complete &= segment.start_ms == 0
            && segment.end_ms.abs_diff(reference.duration_ms) <= 2
            && !reference.transcript.trim().is_empty();
        transcript.push(reference.transcript.trim());
        args.extend([
            "-protocol_whitelist".into(),
            "file,pipe".into(),
            "-i".into(),
            project::asset(&root, &reference.path)?
                .to_string_lossy()
                .into_owned(),
        ]);
        filters.push(format!("[{i}:a:0]atrim=start={:.6}:end={:.6},asetpts=PTS-STARTPTS,aresample=24000,aformat=sample_fmts=s16:channel_layouts=mono[p{i}]",segment.start_ms as f64/1000.0,segment.end_ms as f64/1000.0));
    }
    if total < 1000 {
        return Err("INVALID_REFERENCE_RANGE".into());
    }
    let folder = project::ensure_directory(&root, "characters")?;
    let id = crate::domain::id();
    let relative = format!("characters/combined-{id}.wav");
    let output = root.join(&relative);
    filters.push(format!(
        "{}concat=n={}:v=0:a=1[out]",
        (0..segments.len())
            .map(|i| format!("[p{i}]"))
            .collect::<String>(),
        segments.len()
    ));
    let graph = folder.join(format!("combined-{id}.ffgraph"));
    project::atomic_write(&graph, filters.join(";\n").as_bytes())?;
    args.extend([
        "-/filter_complex".into(),
        graph.to_string_lossy().into_owned(),
        "-map".into(),
        "[out]".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        "24000".into(),
        "-c:a".into(),
        "pcm_s16le".into(),
        "-n".into(),
        output.to_string_lossy().into_owned(),
    ]);
    let flag = std::sync::atomic::AtomicBool::new(false);
    process(
        &core,
        &app,
        "",
        &crate::media::binary(&app, "ffmpeg")?,
        &args,
        &flag,
    )
    .await?;
    let info = crate::media::probe_audio(&app, &output).await?;
    if info.duration_ms.abs_diff(total) > 4 {
        return Err("INVALID_REFERENCE_AUDIO".into());
    }
    let guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_ref().ok_or("NO_PROJECT")?;
    if s.root != root || s.project.id != p.id || s.project.revision != p.revision {
        return Err("STALE_REVISION".into());
    }
    Ok(crate::domain::VoiceReference {
        id,
        label: label.trim().into(),
        path: relative,
        duration_ms: info.duration_ms,
        transcript: if complete {
            transcript.join(" ")
        } else {
            String::new()
        },
        source_dialogue_id: None,
    })
}

pub async fn preview_sample<R: tauri::Runtime>(
    core: std::sync::Arc<crate::Core>,
    app: tauri::AppHandle<R>,
    line_id: String,
    track_id: Option<String>,
) -> Result<String, String> {
    if crate::jobs::active_processing(&core) {
        return Err("BUSY".into());
    }
    let _permit = core.gate.clone().try_acquire_owned().map_err(|_| "BUSY")?;
    let (root, p) = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        (s.root.clone(), s.project.clone())
    };
    let line = p
        .dialogues
        .iter()
        .find(|l| l.id == line_id)
        .ok_or("NO_DIALOGUES")?;
    let track = crate::audio_patch::source_track(&p, track_id.as_deref())?;
    let folder = project::ensure_directory(&root, "cache")?;
    let output = folder.join(format!("character-preview-{}.wav", crate::domain::id()));
    let flag = std::sync::atomic::AtomicBool::new(false);
    crate::audio_patch::snippet(
        &core,
        &app,
        "",
        &p,
        &root,
        crate::audio_patch::Snippet {
            track_id: &track.id,
            start_ms: line.start_ms,
            end_ms: line.end_ms.min(line.start_ms + 20000),
            channels: 1,
            rate: 24000,
            fader: false,
        },
        &output,
        &flag,
    )
    .await?;
    let guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_ref().ok_or("NO_PROJECT")?;
    if s.root != root || s.project.id != p.id || s.project.revision != p.revision {
        let _ = std::fs::remove_file(&output);
        return Err("STALE_REVISION".into());
    }
    Ok(output.to_string_lossy().into_owned())
}

#[cfg(test)]
mod process_tests {
    use super::direct_process;
    use std::{path::PathBuf, sync::atomic::AtomicBool, time::Duration};

    fn shell(script: &str) -> (PathBuf, Vec<String>) {
        if cfg!(windows) {
            (
                "powershell.exe".into(),
                vec![
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-Command".into(),
                    script.into(),
                ],
            )
        } else {
            ("sh".into(), vec!["-c".into(), script.into()])
        }
    }
    #[tokio::test]
    async fn interactive_preview_closes_stdin_and_reports_process_and_worker_errors() {
        let (exe, args) = shell(if cfg!(windows) {
            "[Console]::In.ReadToEnd() | Out-Null; [Console]::Out.Write('{\"progress\":1}')"
        } else {
            "cat >/dev/null; printf '%s' '{\"progress\":1}'"
        });
        direct_process(
            &exe,
            &args,
            &AtomicBool::new(false),
            Duration::from_secs(30),
        )
        .await
        .unwrap();
        let (exe, args) = shell(if cfg!(windows) {
            "[Console]::Error.Write('bad preview'); exit 1"
        } else {
            "printf 'bad preview' >&2; exit 1"
        });
        assert!(direct_process(
            &exe,
            &args,
            &AtomicBool::new(false),
            Duration::from_secs(30)
        )
        .await
        .unwrap_err()
        .contains("bad preview"));
        let (exe, args) = shell(if cfg!(windows) {
            "[Console]::Out.Write('{\"error\":\"CHARACTER_PORTRAIT_INVALID\"}'); exit 1"
        } else {
            "printf '%s' '{\"error\":\"CHARACTER_PORTRAIT_INVALID\"}'; exit 1"
        });
        assert_eq!(
            direct_process(
                &exe,
                &args,
                &AtomicBool::new(false),
                Duration::from_secs(30)
            )
            .await
            .unwrap_err(),
            "CHARACTER_PORTRAIT_INVALID"
        );
    }
    #[tokio::test]
    async fn interactive_preview_deadline_and_cancellation_stop_stalled_processes() {
        let (exe, args) = shell(if cfg!(windows) {
            "Start-Sleep -Seconds 30"
        } else {
            "exec sleep 30"
        });
        let started = std::time::Instant::now();
        assert!(direct_process(
            &exe,
            &args,
            &AtomicBool::new(false),
            Duration::from_millis(100)
        )
        .await
        .unwrap_err()
        .contains("timeout"));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(
            direct_process(&exe, &args, &AtomicBool::new(true), Duration::from_secs(30))
                .await
                .unwrap_err(),
            "CANCELLED"
        );
    }
}
