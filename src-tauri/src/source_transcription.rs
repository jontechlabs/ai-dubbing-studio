//! Audio-to-source-text proposals. Only explicit application edits the original SRT.
use crate::{
    domain::{io_error, now, Project},
    jobs, project, Core,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::Emitter;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub line_id: String,
    pub language: String,
    pub track_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    pub cue_id: Option<String>,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Basis {
    pub project_id: String,
    pub line_id: String,
    pub source_language: String,
    pub source_path: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub slots: Vec<Slot>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub root: PathBuf,
    pub options: Options,
    pub basis: Basis,
    pub fingerprint: String,
    pub created_at: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub text: String,
    pub no_speech: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub basis: Basis,
    pub segments: Vec<Segment>,
    pub track_id: String,
    pub language: String,
    pub stale: bool,
    pub model: String,
}

pub(crate) fn basis(p: &Project, line_id: &str) -> Result<Basis, String> {
    let media = p.media.as_ref().ok_or("MEDIA_MISSING")?;
    let line = p
        .dialogues
        .iter()
        .find(|l| l.id == line_id)
        .ok_or("NO_DIALOGUES")?;
    let slots = if line.source_cue_ids.is_empty() {
        vec![Slot {
            cue_id: None,
            start_ms: line.start_ms,
            end_ms: line.end_ms,
            text: String::new(),
        }]
    } else {
        line.source_cue_ids
            .iter()
            .map(|id| {
                p.source_cues
                    .iter()
                    .find(|c| &c.id == id)
                    .map(|c| Slot {
                        cue_id: Some(c.id.clone()),
                        start_ms: c.start_ms,
                        end_ms: c.end_ms,
                        text: c.text.clone(),
                    })
                    .ok_or("INVALID_CUE".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    if slots.len() > 16
        || slots
            .iter()
            .any(|s| s.end_ms <= s.start_ms || s.end_ms > media.info.duration_ms)
        || slots.iter().map(|s| s.end_ms - s.start_ms).sum::<u64>() > 120000
    {
        return Err("ASR_RANGE_TOO_LONG".into());
    }
    Ok(Basis {
        project_id: p.id.clone(),
        line_id: line.id.clone(),
        source_language: p.languages.source.clone(),
        source_path: media.path.clone(),
        start_ms: line.start_ms,
        end_ms: line.end_ms,
        slots,
    })
}
pub(crate) fn stamp(root: &Path, path: &str) -> Result<serde_json::Value, String> {
    let path = project::asset(root, path)?;
    let m = std::fs::metadata(path).map_err(io_error)?;
    Ok(
        serde_json::json!({"bytes":m.len(),"modified":m.modified().map_err(io_error)?.duration_since(std::time::UNIX_EPOCH).map_err(io_error)?.as_nanos().to_string()}),
    )
}
pub(crate) fn fingerprint(p: &Project, root: &Path, o: &Options) -> Result<String, String> {
    if !crate::transcription::language_valid(&o.language) {
        return Err("ASR_LANGUAGE_UNSUPPORTED".into());
    }
    let basis = basis(p, &o.line_id)?;
    let track = crate::audio_patch::source_track(p, o.track_id.as_deref())?;
    let input = if track.kind == "original" {
        &p.media.as_ref().unwrap().path
    } else {
        track.path.as_ref().ok_or("INVALID_PATH")?
    };
    if track.kind == "original" && p.media.as_ref().unwrap().audio_stream_index.is_none() {
        return Err("NO_AUDIO".into());
    }
    let patches = crate::audio_patch::layers(p, &track.id);
    let mut files = vec![stamp(root, input)?];
    for patch in &patches {
        if let Some(path) = &patch.path {
            files.push(stamp(root, path)?);
        }
    }
    let value = serde_json::json!({"basis":basis,"language":o.language,"trackId":track.id,"trackPath":track.path,"regions":track.regions,"regionsEnabled":track.regions_enabled,"audioStream":p.media.as_ref().unwrap().audio_stream_index,"patches":patches,"files":files});
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&value).map_err(io_error)?)
    ))
}
pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    options: Options,
) -> Result<String, String> {
    if crate::tts::busy(&core) {
        return Err("BUSY".into());
    }
    let request = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        Request {
            root: s.root.clone(),
            basis: basis(&s.project, &options.line_id)?,
            fingerprint: fingerprint(&s.project, &s.root, &options)?,
            options,
            created_at: now(),
        }
    };
    resume(core, app, request)
}
pub fn resume<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    mut request: Request,
) -> Result<String, String> {
    if crate::tts::busy(&core) {
        return Err("BUSY".into());
    }
    {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        if s.root != request.root
            || fingerprint(&s.project, &s.root, &request.options)? != request.fingerprint
        {
            return Err("STALE_REVISION".into());
        }
    }
    request.created_at = now();
    let key = jobs::create(
        &core,
        &app,
        "sourceTranscription",
        request.basis.project_id.clone(),
        None,
    );
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .ok_or("INVALID_PROJECT")?
        .saved
        .source_transcription = Some(request.clone());
    jobs::persist(&core);
    let returned = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result=async{
            let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),permit=core.gate.clone().acquire_owned()=>permit.map_err(io_error)?};
            let work=run(&core,&app,&key,&request,&flag);tokio::pin!(work);
            tokio::select!{_=tokio::time::sleep(std::time::Duration::from_secs(600))=>{flag.store(true,Ordering::Relaxed);let _=work.await;Err("ASR_FAILED".into())},result=&mut work=>result}
        }.await;
        crate::separation::finish(&core, &app, &key, &result);
    });
    Ok(returned)
}
async fn run<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    r: &Request,
    flag: &AtomicBool,
) -> Result<(), String> {
    let p = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        if s.root != r.root || fingerprint(&s.project, &s.root, &r.options)? != r.fingerprint {
            return Err("STALE_REVISION".into());
        }
        s.project.clone()
    };
    jobs::update(core, app, key, |j| {
        j.status = "running".into();
        j.stage = "asrModel".into();
        j.progress = Some(0.0);
        j.logs.push("Whisper small multilingual Q5_1, local CPU. Proposals only; original/translated subtitles and takes are unchanged until explicit acceptance.".into());
    });
    let model = crate::transcription::ensure_model(core, app, key, flag).await?;
    project::ensure_directory(&r.root, "cache")?;
    let parent = project::ensure_directory(&r.root, "cache/source-transcription")?;
    let temporary = tempfile::Builder::new()
        .prefix("source-asr-")
        .tempdir_in(&parent)
        .map_err(io_error)?;
    let track = crate::audio_patch::source_track(&p, r.options.track_id.as_deref())?;
    let mut segments = vec![];
    for (i, slot) in r.basis.slots.iter().enumerate() {
        if flag.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        jobs::update(core, app, key, |j| {
            j.stage = "asrPrepare".into();
            j.progress = None;
            j.logs.push(format!(
                "Source subtitle {}/{}: {}–{} ms, track {}",
                i + 1,
                r.basis.slots.len(),
                slot.start_ms,
                slot.end_ms,
                track.id
            ));
        });
        let wav = temporary.path().join("source.wav");
        let pcm = temporary.path().join(format!("source-{i}.f32"));
        let result = temporary.path().join(format!("result-{i}.json"));
        crate::audio_patch::snippet(
            core,
            app,
            key,
            &p,
            &r.root,
            crate::audio_patch::Snippet {
                track_id: &track.id,
                start_ms: slot.start_ms,
                end_ms: slot.end_ms,
                channels: 1,
                rate: 16000,
                fader: false,
            },
            &wav,
            flag,
        )
        .await?;
        crate::separation::process(
            core,
            app,
            key,
            &crate::media::binary(app, "ffmpeg")?,
            &[
                "-nostdin".into(),
                "-v".into(),
                "error".into(),
                "-i".into(),
                wav.to_string_lossy().into_owned(),
                "-ac".into(),
                "1".into(),
                "-ar".into(),
                "16000".into(),
                "-af".into(),
                "apad=whole_dur=1".into(),
                "-f".into(),
                "f32le".into(),
                "-n".into(),
                pcm.to_string_lossy().into_owned(),
            ],
            flag,
        )
        .await?;
        jobs::update(core, app, key, |j| {
            j.stage = "asrLoad".into();
            j.progress = None;
        });
        let inference = crate::separation::process(
            core,
            app,
            key,
            &std::env::current_exe().map_err(io_error)?,
            &[
                "--transcribe-dialogue".into(),
                model.to_string_lossy().into_owned(),
                pcm.to_string_lossy().into_owned(),
                r.options.language.clone(),
                result.to_string_lossy().into_owned(),
            ],
            flag,
        )
        .await;
        match inference {
            Ok(()) => {
                let v: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(result).map_err(io_error)?)
                        .map_err(io_error)?;
                segments.push(Segment {
                    text: crate::transcription::valid_transcript(
                        v["text"].as_str().ok_or("ASR_FAILED")?,
                    )?,
                    no_speech: false,
                });
            }
            Err(e) if e == "ASR_EMPTY_AUDIO" => segments.push(Segment {
                text: slot.text.clone(),
                no_speech: true,
            }),
            Err(e) => return Err(e),
        }
    }
    if flag.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    let proposal = Proposal {
        id: key.into(),
        basis: r.basis.clone(),
        segments,
        track_id: track.id,
        language: r.options.language.clone(),
        stale: false,
        model: "Whisper small multilingual Q5_1 · CPU".into(),
    };
    project::atomic_write(
        &parent.join(format!("{key}.json")),
        &serde_json::to_vec(&proposal).map_err(io_error)?,
    )
}
fn stored(core: &Core, key: &str) -> Result<Option<Request>, String> {
    let jobs = core.jobs.lock().map_err(io_error)?;
    let job = jobs.get(key).ok_or("INVALID_PROJECT")?;
    Ok((job.saved.record.status == "succeeded")
        .then(|| job.saved.source_transcription.clone())
        .flatten())
}
pub fn result(core: &Core, key: &str) -> Result<Option<Proposal>, String> {
    let Some(r) = stored(core, key)? else {
        return Ok(None);
    };
    let path = project::asset(&r.root, &format!("cache/source-transcription/{key}.json"))?;
    let mut data: Proposal =
        serde_json::from_slice(&std::fs::read(path).map_err(io_error)?).map_err(io_error)?;
    if data.basis != r.basis || data.id != key || data.segments.len() != r.basis.slots.len() {
        return Err("ASR_FAILED".into());
    }
    let guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_ref().ok_or("NO_PROJECT")?;
    if s.root != r.root || s.project.id != r.basis.project_id {
        return Err("STALE_REVISION".into());
    }
    data.stale = !fingerprint(&s.project, &s.root, &r.options).is_ok_and(|f| f == r.fingerprint);
    Ok(Some(data))
}
pub fn latest(core: &Core, line_id: &str) -> Result<Option<String>, String> {
    let guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_ref().ok_or("NO_PROJECT")?;
    let jobs = core.jobs.lock().map_err(io_error)?;
    Ok(jobs
        .values()
        .filter_map(|j| {
            j.saved
                .source_transcription
                .as_ref()
                .filter(|r| {
                    r.root == s.root
                        && r.basis.project_id == s.project.id
                        && r.options.line_id == line_id
                })
                .map(|r| (r.created_at.clone(), j.saved.record.id.clone()))
        })
        .max()
        .map(|(_, id)| id))
}
pub(crate) fn applied(p: &Project, b: &Basis, texts: &[String]) -> Result<Project, String> {
    if basis(p, &b.line_id)? != *b {
        return Err("STALE_REVISION".into());
    }
    if texts.len() != b.slots.len()
        || texts
            .iter()
            .any(|t| t.trim().is_empty() || t.chars().count() > 10000 || t.contains('\0'))
    {
        return Err("ASR_OUTPUT_INVALID".into());
    }
    let mut next = p.clone();
    let mut changed = vec![];
    for (slot, text) in b.slots.iter().zip(texts) {
        let text = text.trim();
        if text == slot.text {
            continue;
        }
        if let Some(id) = &slot.cue_id {
            next.source_cues
                .iter_mut()
                .find(|c| &c.id == id)
                .ok_or("STALE_REVISION")?
                .text = text.into();
            changed.push(id.clone());
        } else {
            let id = crate::domain::id();
            next.source_cues.push(crate::domain::Cue {
                id: id.clone(),
                start_ms: slot.start_ms,
                end_ms: slot.end_ms,
                text: text.into(),
            });
            next.dialogues
                .iter_mut()
                .find(|l| l.id == b.line_id)
                .ok_or("STALE_REVISION")?
                .source_cue_ids
                .push(id.clone());
            changed.push(id);
        }
    }
    for line in &mut next.dialogues {
        if line.source_cue_ids.iter().any(|id| changed.contains(id)) {
            next.translation_approvals.remove(&line.id);
            if ["generated", "validated"].contains(&line.status.as_str()) {
                line.status = "review".into();
            }
        }
    }
    next.validate()?;
    Ok(next)
}
pub fn apply<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    key: String,
    texts: Vec<String>,
) -> Result<Project, String> {
    let r = stored(core, &key)?.ok_or("ASR_FAILED")?;
    let mut guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_mut().ok_or("NO_PROJECT")?;
    if s.root != r.root || fingerprint(&s.project, &s.root, &r.options)? != r.fingerprint {
        return Err("STALE_REVISION".into());
    }
    let next = applied(&s.project, &r.basis, &texts)?;
    let saved = s.replace(next, s.project.revision)?;
    app.emit("project-changed", &saved).map_err(io_error)?;
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn proposal_apply_preserves_cue_times_targets_and_takes_and_is_undoable() {
        let (_temporary, root, mut p) = crate::mix::tests::fixture().await;
        let first = p.source_cues[0].clone();
        let mut second = first.clone();
        second.id = "s2".into();
        second.start_ms = 2000;
        second.text = "Second source".into();
        p.source_cues[0].end_ms = 2000;
        p.source_cues.push(second);
        p.dialogues[0].source_cue_ids.push("s2".into());
        let b = basis(&p, "line").unwrap();
        let before = serde_json::to_value(&p).unwrap();
        let next = applied(&p, &b, &["日本語の訂正".into(), "二番目".into()]).unwrap();
        assert_eq!(next.source_cues[0].text, "日本語の訂正");
        assert_eq!(next.source_cues[1].text, "二番目");
        let after = serde_json::to_value(&next).unwrap();
        for field in ["targetCues", "generations", "dubbingTiming", "voiceEdits"] {
            assert_eq!(before[field], after[field]);
        }
        for i in 0..2 {
            for field in ["id", "startMs", "endMs"] {
                assert_eq!(
                    before["sourceCues"][i][field],
                    after["sourceCues"][i][field]
                );
            }
        }
        assert_eq!(next.dialogues[0].status, "review");
        assert_eq!(
            applied(&next, &b, &["autre".into(), "autre".into()]).unwrap_err(),
            "STALE_REVISION"
        );
        assert_eq!(
            applied(&p, &b, &["".into(), "valid".into()]).unwrap_err(),
            "ASR_OUTPUT_INVALID"
        );
        let mut session = project::Session::new(root, p.clone());
        session.replace(next, p.revision).unwrap();
        let undone = session.history(false).unwrap();
        assert_eq!(
            serde_json::to_value(undone.source_cues).unwrap(),
            before["sourceCues"]
        );
    }
    #[tokio::test]
    async fn snapshot_accepts_target_edits_but_rejects_changed_audio_and_invalid_bounds() {
        let (_temporary, root, mut p) = crate::mix::tests::fixture().await;
        let o = Options {
            line_id: "line".into(),
            language: "ja".into(),
            track_id: Some("original".into()),
        };
        let original = fingerprint(&p, &root, &o).unwrap();
        p.target_cues[0].text = "Nouvelle traduction".into();
        assert_eq!(fingerprint(&p, &root, &o).unwrap(), original);
        p.source_cues[0].text = "Correction source".into();
        assert_ne!(fingerprint(&p, &root, &o).unwrap(), original);
        p.source_cues[0].text = "Hello".into();
        std::fs::write(root.join("media/source.mkv"), b"changed audio").unwrap();
        assert_ne!(fingerprint(&p, &root, &o).unwrap(), original);
        p.media.as_mut().unwrap().audio_stream_index = None;
        assert_eq!(fingerprint(&p, &root, &o).unwrap_err(), "NO_AUDIO");
        p.media.as_mut().unwrap().info.duration_ms = 130000;
        p.source_cues[0].end_ms = 122000;
        assert_eq!(basis(&p, "line").unwrap_err(), "ASR_RANGE_TOO_LONG");
        p.source_cues[0].end_ms = p.source_cues[0].start_ms;
        assert!(basis(&p, "line").is_err());
    }
    #[tokio::test]
    async fn missing_source_is_created_only_on_explicit_acceptance() {
        let (_temporary, _root, mut p) = crate::mix::tests::fixture().await;
        p.dialogues[0].source_cue_ids.clear();
        p.source_cues.clear();
        let b = basis(&p, "line").unwrap();
        assert_eq!(b.slots[0].cue_id, None);
        assert!(applied(&p, &b, &[String::new()]).is_err());
        let n = applied(&p, &b, &["日本語".into()]).unwrap();
        assert_eq!(n.source_cues.len(), 1);
        assert_eq!(n.source_cues[0].start_ms, 1000);
        assert_eq!(n.source_cues[0].end_ms, 3000);
        assert_eq!(n.dialogues[0].source_cue_ids[0], n.source_cues[0].id);
        assert!(p.source_cues.is_empty());
    }
}
