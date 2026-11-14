//! Non-destructive, cancellable review of selected takes. Audio findings are hints, never edits.
use crate::{
    domain::{io_error, Project},
    jobs, media, mix, project, separation, Core,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::Emitter;
pub const TAGS: &[&str] = &[
    "missing",
    "silent",
    "multipleVoices",
    "quiet",
    "clipping",
    "cutEnd",
    "longSilence",
    "timing",
    "invalidAudio",
];
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub voices: String,
    pub source_track_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub root: PathBuf,
    pub project_id: String,
    pub revision: u64,
    pub options: Options,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub rms_db: f64,
    pub peak_db: f64,
    pub duration_ms: u64,
    pub leading_ms: u64,
    pub trailing_ms: u64,
    pub clipped_samples: u64,
    pub end_db: f64,
    pub last_sample: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub line_id: String,
    pub take_id: Option<String>,
    pub tags: Vec<String>,
    pub metrics: Option<Metrics>,
    pub source_voices: Option<u32>,
    pub dubbing_voices: Option<u32>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub id: String,
    pub created_at: String,
    pub basis: Value,
    pub rows: Vec<Row>,
    pub voices_status: String,
    pub source_track_id: String,
}
pub fn basis(p: &Project) -> Value {
    json!({"sourcePath":p.media.as_ref().map(|m|&m.path),"language":p.languages.target,
 "lines":p.dialogues.iter().map(|l|json!({"id":l.id,"startMs":l.start_ms,"endMs":l.end_ms,"takeId":l.selected_generation_ids.get(&p.languages.target),"ttsText":l.tts_text,"excluded":l.excluded_from_dubbing.unwrap_or(false)})).collect::<Vec<_>>(),
 "sourceCues":p.source_cues,"targetCues":p.target_cues,
 "takes":p.generations.iter().filter(|g|g["kind"]=="tts").map(|g|json!({"id":g["id"],"path":g["path"],"durationMs":g["durationMs"]})).collect::<Vec<_>>(),
 "edits":p.voice_edits,"timing":p.dubbing_timing,
 "patches":p.generations.iter().filter(|g|g["kind"]=="audioPatch").collect::<Vec<_>>(),
 "groups":p.speaker_dubbings,"tracks":p.tracks.iter().filter(|t|t.kind!="dubbing").map(|t|json!({"id":t.id,"path":t.path,"sourcePath":t.source_path})).collect::<Vec<_>>()})
}
pub fn validate(p: &Project) -> Result<(), String> {
    if let Some(a) = &p.dubbing_audit {
        if !a.basis.is_object()
            || !a.basis["edits"].is_object()
            || [
                "lines",
                "takes",
                "sourceCues",
                "targetCues",
                "tracks",
                "patches",
                "groups",
            ]
            .iter()
            .any(|k| !a.basis[*k].is_array())
            || ["lines", "takes", "sourceCues", "targetCues"]
                .iter()
                .any(|k| {
                    a.basis[*k]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|v| !v["id"].is_string())
                })
        {
            return Err("INVALID_DUBBING_AUDIT".into());
        }
        if p.format_version < 29
            || a.rows.len() > 50000
            || a.id.is_empty()
            || a.rows.iter().any(|r| {
                r.line_id.is_empty()
                    || r.tags.iter().any(|t| !TAGS.contains(&t.as_str()))
                    || r.metrics.as_ref().is_some_and(|m| {
                        ![m.rms_db, m.peak_db, m.end_db, m.last_sample]
                            .iter()
                            .all(|n| n.is_finite())
                    })
            })
            || a.rows
                .iter()
                .map(|r| &r.line_id)
                .collect::<std::collections::HashSet<_>>()
                .len()
                != a.rows.len()
        {
            return Err("INVALID_DUBBING_AUDIT".into());
        }
    }
    Ok(())
}
fn db(v: f64) -> f64 {
    20.0 * v.max(1e-9).log10()
}
pub fn measure(path: &Path, flag: &AtomicBool) -> Result<Metrics, String> {
    let frames = crate::audio_files::pcm_frames(path, 1, 24000, "INVALID_GENERATION")?;
    if frames > 120 * 24000 {
        return Err("INVALID_GENERATION".into());
    }
    let mut file = std::io::BufReader::new(std::fs::File::open(path).map_err(io_error)?);
    file.seek(SeekFrom::Start(12)).map_err(io_error)?;
    loop {
        let mut c = [0; 8];
        file.read_exact(&mut c).map_err(io_error)?;
        if &c[..4] == b"data" {
            break;
        }
        let n = u32::from_le_bytes(c[4..].try_into().unwrap());
        file.seek(SeekFrom::Current(i64::from(n) + i64::from(n % 2)))
            .map_err(io_error)?;
    }
    let mut pos = 0;
    let mut energy = 0.0;
    let mut peak: f64 = 0.0;
    let mut clipped = 0;
    let mut first = None;
    let mut last = 0;
    let mut tail = 0.0;
    let mut final_sample = 0.0;
    let mut bytes = [0; 8192];
    while pos < frames {
        if flag.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        let count = (frames - pos).min(4096) as usize;
        file.read_exact(&mut bytes[..count * 2]).map_err(io_error)?;
        for (i, b) in bytes[..count * 2].as_chunks::<2>().0.iter().enumerate() {
            let raw = i16::from_le_bytes(*b);
            let v = f64::from(raw) / 32768.0;
            let frame = pos + i as u64;
            energy += v * v;
            peak = peak.max(v.abs());
            final_sample = v.abs();
            if raw.unsigned_abs() >= 32760 {
                clipped += 1;
            }
            if v.abs() > 0.003 {
                first.get_or_insert(frame);
                last = frame;
            }
            if frame >= frames.saturating_sub(480) {
                tail += v * v;
            }
        }
        pos += count as u64;
    }
    Ok(Metrics {
        rms_db: db((energy / frames as f64).sqrt()),
        peak_db: db(peak),
        duration_ms: frames / 24,
        leading_ms: first.unwrap_or(frames) / 24,
        trailing_ms: if first.is_none() {
            frames / 24
        } else {
            (frames - 1 - last) / 24
        },
        clipped_samples: clipped,
        end_db: db((tail / frames.min(480) as f64).sqrt()),
        last_sample: final_sample,
    })
}
fn metric_tags(m: &Metrics) -> Vec<String> {
    let mut tags = vec![];
    if m.peak_db < -60.0 {
        tags.push("silent".into());
    } else {
        if m.rms_db < -35.0 {
            tags.push("quiet".into());
        }
        if m.clipped_samples >= 3 && m.clipped_samples * 1000 >= m.duration_ms * 24 {
            tags.push("clipping".into());
        }
        if m.end_db > -30.0 && m.last_sample > 0.01 {
            tags.push("cutEnd".into());
        }
        if m.leading_ms > 500 || m.trailing_ms > 500 {
            tags.push("longSilence".into());
        }
    }
    tags
}
pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    project_id: String,
    revision: u64,
    options: Options,
) -> Result<String, String> {
    if !["off", "source", "dubbing", "both"].contains(&options.voices.as_str()) {
        return Err("INVALID_DUBBING_AUDIT".into());
    }
    let (r, p) = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        if s.project.id != project_id || s.project.revision != revision {
            return Err("STALE_REVISION".into());
        }
        if s.project.media.is_none()
            || s.project.dialogues.is_empty()
            || s.project.dialogues.len() > 50000
        {
            return Err("NO_DIALOGUES".into());
        }
        (
            Request {
                root: s.root.clone(),
                project_id,
                revision,
                options,
            },
            s.project.clone(),
        )
    };
    let permit = core.gate.clone().try_acquire_owned().map_err(|_| "BUSY")?;
    let key = jobs::create(&core, &app, "dubbingAudit", p.id.clone(), None);
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .ok_or("INVALID_JOB")?
        .saved
        .dubbing_audit = Some(r.clone());
    jobs::persist(&core);
    let returned = key.clone();
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let flag = core.jobs.lock().unwrap()[&key].cancel.clone();
        jobs::update(&core, &app, &key, |j| {
            j.status = "running".into();
            j.stage = "auditAudio".into();
        });
        let result = execute(&core, &app, &key, &r, &p, &flag).await;
        separation::finish(&core, &app, &key, &result);
    });
    Ok(returned)
}
async fn execute<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    r: &Request,
    p: &Project,
    flag: &Arc<AtomicBool>,
) -> Result<(), String> {
    let cache = project::ensure_directory(&r.root, "cache")?;
    let temp = tempfile::tempdir_in(cache).map_err(io_error)?;
    let ffmpeg = media::binary(app, "ffmpeg")?;
    let clips = mix::clips(p);
    let mut rows = vec![];
    let mut inputs = vec![];
    let media = p.media.as_ref().ok_or("MEDIA_MISSING")?;
    let source_track = if let Some(id) = r
        .options
        .source_track_id
        .as_deref()
        .filter(|id| *id != "auto")
    {
        crate::audio_patch::source_track(p, Some(id))?.id
    } else {
        mix::tracks(p)
            .into_iter()
            .find(|t| t.role.as_deref() == Some("speech"))
            .map(|t| t.id)
            .unwrap_or_else(|| "original".into())
    };
    for (index, line) in p.dialogues.iter().enumerate() {
        if flag.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        let take = line.selected_generation_ids.get(&p.languages.target);
        let mut row = Row {
            line_id: line.id.clone(),
            take_id: take.cloned(),
            tags: vec![],
            metrics: None,
            source_voices: None,
            dubbing_voices: None,
            error: None,
        };
        if line.excluded_from_dubbing.unwrap_or(false) {
            rows.push(row);
            continue;
        }
        let group = p
            .speaker_dubbings
            .iter()
            .find(|g| g.active && g.source_path == media.path && g.parent_id == line.id);
        if group.is_some_and(|g| g.voices.len() > 1) {
            row.tags.push("multipleVoices".into());
            row.source_voices = group.map(|g| g.voices.len() as u32);
        }
        let generation = take.filter(|_| group.is_none()).and_then(|id| {
            p.generations.iter().find(|g| {
                g["id"] == *id
                    && g["kind"] == "tts"
                    && g["language"] == p.languages.target
                    && g["sourcePath"] == media.path
            })
        });
        let mut dub = None;
        if let Some(g) = generation {
            let result = async {
                let path = g["path"].as_str().ok_or("INVALID_GENERATION")?;
                let edited = crate::voice_edit::render(
                    &r.root,
                    path,
                    p.voice_edits.get(take.unwrap()),
                    &ffmpeg,
                    flag,
                )
                .await?;
                let relative = edited
                    .strip_prefix(&r.root)
                    .map_err(io_error)?
                    .to_string_lossy()
                    .replace('\\', "/");
                let clip = clips.iter().find(|c| Some(&c.id) == take);
                let fitted = if let Some(c) = clip.filter(|c| c.slot_ms > 0) {
                    if crate::audio_files::pcm_frames(&edited, 1, 24000, "INVALID_GENERATION")? / 24
                        > c.slot_ms * 3 / 2
                    {
                        row.tags.push("timing".into());
                    }
                    crate::voice_fit::take_with_duration(
                        &r.root,
                        &relative,
                        c.slot_ms,
                        c.exact_duration,
                        &ffmpeg,
                        flag,
                    )
                    .await?
                } else {
                    row.tags.push("timing".into());
                    edited
                };
                let file = fitted.clone();
                let cancel = flag.clone();
                let metrics = tauri::async_runtime::spawn_blocking(move || measure(&file, &cancel))
                    .await
                    .map_err(io_error)??;
                row.tags.extend(metric_tags(&metrics));
                row.metrics = Some(metrics);
                dub = Some(fitted);
                Ok::<_, String>(())
            }
            .await;
            if let Err(e) = result {
                if e == "CANCELLED" {
                    return Err(e);
                }
                row.tags.push(
                    if g["path"]
                        .as_str()
                        .is_none_or(|v| project::asset(&r.root, v).is_err())
                    {
                        "missing"
                    } else {
                        "invalidAudio"
                    }
                    .into(),
                );
                row.error = Some(e);
            }
        } else if !group.is_some_and(|g| {
            g.voices.iter().all(|v| {
                p.dialogues
                    .iter()
                    .find(|l| l.id == v.line_id)
                    .is_some_and(|l| l.selected_generation_ids.contains_key(&p.languages.target))
            })
        }) {
            row.tags.push("missing".into());
        }
        inputs
            .push(json!({"id":line.id,"startMs":line.start_ms,"endMs":line.end_ms,"dubbing":dub}));
        rows.push(row);
        jobs::update(core, app, key, |j| {
            j.progress = Some((index + 1) as f64 / p.dialogues.len() as f64)
        });
    }
    let mut status = "disabled".to_owned();
    if r.options.voices != "off" {
        status = if crate::speakers::installed(core) {
            "completed"
        } else {
            "unavailable"
        }
        .into();
        if status == "completed" {
            jobs::update(core, app, key, |j| {
                j.stage = "auditVoices".into();
                j.progress = Some(0.0);
            });
            let result:Result<Vec<Value>,String>=async {
            let source = temp.path().join("source.wav");
            if ["source", "both"].contains(&r.options.voices.as_str()) {
                crate::audio_patch::snippet(
                    core,
                    app,
                    key,
                    p,
                    &r.root,
                    crate::audio_patch::Snippet {
                        track_id: &source_track,
                        start_ms: 0,
                        end_ms: media.info.duration_ms,
                        channels: 1,
                        rate: 16000,
                        levels: crate::audio_patch::SnippetLevels::Reference,
                    },
                    &source,
                    flag,
                )
                .await?;
            }
            let input = temp.path().join("input.json");
            let output = temp.path().join("voices.json");
            project::atomic_write(&input,&serde_json::to_vec(&json!({"entries":inputs,"source":if source.exists(){Some(source)}else{None},"mode":r.options.voices})).map_err(io_error)?)?;
            separation::process(
                core,
                app,
                key,
                &separation::python(&crate::speakers::root(core)),
                &[
                    separation::resources(app)
                        .join("dubbing_audit_worker.py")
                        .to_string_lossy()
                        .into_owned(),
                    "--runtime".into(),
                    crate::speakers::root(core).to_string_lossy().into_owned(),
                    "--input".into(),
                    input.to_string_lossy().into_owned(),
                    "--output".into(),
                    output.to_string_lossy().into_owned(),
                ],
                flag,
            )
            .await?;
            serde_json::from_slice::<Vec<Value>>(&std::fs::read(output).map_err(io_error)?).map_err(io_error)
            }.await;
            if let Err(error) = result {
                if error == "CANCELLED" {
                    return Err(error);
                }
                status = "failed".into();
            } else {
                let findings = result?;
                for row in &mut rows {
                    if let Some(v) = findings.iter().find(|v| v["id"] == row.line_id) {
                        row.source_voices = row
                            .source_voices
                            .max(v["sourceVoices"].as_u64().map(|v| v as u32));
                        row.dubbing_voices = v["dubbingVoices"].as_u64().map(|v| v as u32);
                        if row.source_voices.is_some_and(|v| v > 1)
                            || row.dubbing_voices.is_some_and(|v| v > 1)
                        {
                            row.tags.push("multipleVoices".into());
                        }
                        row.tags.sort();
                        row.tags.dedup();
                    }
                }
            }
        }
    }
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    let report = Report {
        id: key.into(),
        created_at: crate::domain::now(),
        basis: basis(p),
        rows,
        voices_status: status,
        source_track_id: source_track,
    };
    let saved = {
        let mut guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_mut().ok_or("NO_PROJECT")?;
        if s.root != r.root || s.project.id != r.project_id || basis(&s.project) != report.basis {
            return Err("STALE_REVISION".into());
        }
        let mut next = s.project.clone();
        next.format_version = next.format_version.max(29);
        next.dubbing_audit = Some(report);
        let revision = s.project.revision;
        s.replace(next, revision)?
    };
    let _ = app.emit("project-changed", &saved);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quiet_silence_clipping_cut_end_and_cancel_are_measured_without_inference() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tone.wav");
        fn write(path: &Path, value: i16) {
            use std::io::Write;
            let mut out = std::fs::File::create(path).unwrap();
            let mut h = vec![];
            h.extend(b"RIFF");
            h.extend(48036_u32.to_le_bytes());
            h.extend(b"WAVEfmt ");
            h.extend(16_u32.to_le_bytes());
            h.extend(1_u16.to_le_bytes());
            h.extend(1_u16.to_le_bytes());
            h.extend(24000_u32.to_le_bytes());
            h.extend(48000_u32.to_le_bytes());
            h.extend(2_u16.to_le_bytes());
            h.extend(16_u16.to_le_bytes());
            h.extend(b"data");
            h.extend(48000_u32.to_le_bytes());
            out.write_all(&h).unwrap();
            out.write_all(&value.to_le_bytes().repeat(24000)).unwrap();
        }
        let flag = AtomicBool::new(false);
        for (value, tag) in [
            (0, "silent"),
            (100, "quiet"),
            (32767, "clipping"),
            (8000, "cutEnd"),
        ] {
            write(&path, value);
            let m = measure(&path, &flag).unwrap();
            assert!(metric_tags(&m).contains(&tag.into()));
            assert_eq!(m.duration_ms, 1000);
        }
        assert_eq!(
            measure(&path, &AtomicBool::new(true)).unwrap_err(),
            "CANCELLED"
        );
    }
    #[tokio::test]
    async fn audit_persists_findings_but_never_changes_sources_or_takes() {
        let (_dir, root, mut p) = crate::mix::tests::fixture().await;
        p.format_version = 29;
        p.dialogues[0].review_tags = vec!["retranslate".into(), "improveVoice".into()];
        let core = crate::mix::tests::core(&root, p.clone());
        let app = tauri::test::mock_app();
        let before = std::fs::read(root.join("generations/voice.wav")).unwrap();
        let id = enqueue(
            core.clone(),
            app.handle().clone(),
            p.id.clone(),
            p.revision,
            Options {
                voices: "off".into(),
                source_track_id: None,
            },
        )
        .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(40);
        loop {
            let j = core.jobs.lock().unwrap()[&id].snapshot();
            if !["running", "queued"].contains(&j.status.as_str()) {
                assert_eq!(j.status, "succeeded", "{:?}", j.error);
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let saved = project::load(&root).unwrap();
        assert_eq!(saved.format_version, 29);
        assert_eq!(saved.generations, p.generations);
        assert_eq!(saved.dialogues.len(), p.dialogues.len());
        assert_eq!(saved.dialogues[0].review_tags, p.dialogues[0].review_tags);
        let mut manual_only = saved.clone();
        manual_only.dialogues[0].review_tags.clear();
        assert_eq!(basis(&manual_only), basis(&saved));
        assert_eq!(saved.dubbing_audit.as_ref().unwrap().basis, basis(&saved));
        assert_eq!(
            std::fs::read(root.join("generations/voice.wav")).unwrap(),
            before
        );
        let mut changed = saved.clone();
        changed.dialogues[0].end_ms -= 100;
        assert_ne!(basis(&changed), saved.dubbing_audit.unwrap().basis);
    }
    #[tokio::test]
    async fn cancelled_audit_does_not_publish_partial_findings() {
        let (_dir, root, p) = crate::mix::tests::fixture().await;
        let core = crate::mix::tests::core(&root, p.clone());
        let app = tauri::test::mock_app();
        let id = enqueue(
            core.clone(),
            app.handle().clone(),
            p.id.clone(),
            p.revision,
            Options {
                voices: "off".into(),
                source_track_id: None,
            },
        )
        .unwrap();
        core.jobs.lock().unwrap()[&id]
            .cancel
            .store(true, Ordering::Relaxed);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let j = core.jobs.lock().unwrap()[&id].snapshot();
            if !["running", "queued"].contains(&j.status.as_str()) {
                assert_eq!(j.status, "cancelled");
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(core
            .session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .project
            .dubbing_audit
            .is_none());
    }
}
