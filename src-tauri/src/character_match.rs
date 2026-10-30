//! Speaker suggestions are transient and require explicit acceptance.
use crate::{
    domain::{io_error, Project, VoiceReference},
    jobs, project, Core,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
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
    pub track_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub root: PathBuf,
    pub project_id: String,
    pub options: Options,
    pub fingerprint: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub character_id: String,
    pub score: f64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultData {
    pub candidates: Vec<Candidate>,
    pub reason: String,
    pub reliable: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub line_id: String,
    pub candidates: Vec<Candidate>,
    pub reason: String,
    pub reliable: bool,
    pub stale: bool,
}

fn references<'a>(p: &'a Project, owner: &'a crate::domain::Character) -> Vec<&'a VoiceReference> {
    let mut result = vec![];
    if let Some(reference) = owner
        .references
        .iter()
        .find(|r| Some(&r.id) == owner.default_reference_id.as_ref())
    {
        result.push(reference);
    }
    if let Some(lib) = crate::voice_library::library(p, &owner.id) {
        for source in lib.sources.iter().rev() {
            result.push(&source.reference);
        }
    }
    for r in &owner.references {
        if !result.iter().any(|old| old.id == r.id) {
            result.push(r);
        }
    }
    result.truncate(3);
    result
}
pub fn fingerprint(
    p: &Project,
    root: &std::path::Path,
    options: &Options,
) -> Result<String, String> {
    let line = p
        .dialogues
        .iter()
        .find(|l| l.id == options.line_id)
        .ok_or("NO_DIALOGUES")?;
    let track = crate::audio_patch::source_track(p, options.track_id.as_deref())?;
    let mut refs = vec![];
    for c in &p.characters {
        for r in references(p, c) {
            let path = project::asset(root, &r.path)?;
            refs.push(serde_json::json!({"owner":c.id,"reference":r,"sha256":crate::voice_library::digest(&path)?}));
        }
    }
    if refs.is_empty() {
        return Err("SPEAKER_REFERENCES_REQUIRED".into());
    }
    let value = serde_json::json!({"isolatedVoice":crate::speaker_dubbing::voice(p,&line.id),"media":p.media.as_ref().map(|m|&m.path),"line":[serde_json::json!(line.id),serde_json::json!(line.start_ms),serde_json::json!(line.end_ms),serde_json::json!(line.character_id)],"track":track,"audio":crate::character_review::audio_snapshot(p,None),"references":refs});
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
    if !crate::speakers::installed(&core) {
        return Err("SPEAKER_RUNTIME_REQUIRED".into());
    }
    if crate::tts::busy(&core) {
        return Err("BUSY".into());
    }
    let request = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        Request {
            root: s.root.clone(),
            project_id: s.project.id.clone(),
            fingerprint: fingerprint(&s.project, &s.root, &options)?,
            options,
        }
    };
    resume(core, app, request)
}
pub fn resume<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    request: Request,
) -> Result<String, String> {
    if !crate::speakers::installed(&core) {
        return Err("SPEAKER_RUNTIME_REQUIRED".into());
    }
    if crate::tts::busy(&core) {
        return Err("BUSY".into());
    }
    {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        if s.root != request.root
            || s.project.id != request.project_id
            || fingerprint(&s.project, &s.root, &request.options)? != request.fingerprint
        {
            return Err("STALE_REVISION".into());
        }
    }
    let key = jobs::create(
        &core,
        &app,
        "characterMatch",
        request.project_id.clone(),
        None,
    );
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .ok_or("INVALID_PROJECT")?
        .saved
        .character_match = Some(request.clone());
    jobs::persist(&core);
    let returned = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result=async {
            let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),permit=core.gate.clone().acquire_owned()=>permit.map_err(io_error)?};
            run(&core,&app,&key,&request,&flag).await
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
        if s.root != r.root
            || s.project.id != r.project_id
            || fingerprint(&s.project, &s.root, &r.options)? != r.fingerprint
        {
            return Err("STALE_REVISION".into());
        }
        s.project.clone()
    };
    let line = p
        .dialogues
        .iter()
        .find(|l| l.id == r.options.line_id)
        .ok_or("NO_DIALOGUES")?;
    project::ensure_directory(&r.root, "cache")?;
    let parent = project::ensure_directory(&r.root, "cache/character-match")?;
    let folder = parent.join(key);
    std::fs::create_dir_all(&folder).map_err(io_error)?;
    jobs::update(core, app, key, |j| {
        j.status = "running".into();
        j.stage = "characterMatch".into();
        j.progress = None;
    });
    let input = folder.join("query.wav");
    let output = folder.join("result.json");
    let track = crate::audio_patch::source_track(&p, r.options.track_id.as_deref())?;
    crate::speaker_dubbing::snippet(
        core,
        app,
        key,
        &p,
        &r.root,
        &line.id,
        crate::audio_patch::Snippet {
            track_id: &track.id,
            start_ms: line.start_ms,
            end_ms: line.end_ms.min(line.start_ms + 20000),
            channels: 1,
            rate: 16000,
            levels: crate::audio_patch::SnippetLevels::Reference,
        },
        &input,
        flag,
    )
    .await?;
    let ffmpeg = crate::media::binary(app, "ffmpeg")?;
    let mut characters = vec![];
    for character in &p.characters {
        let mut enrolled = vec![];
        for reference in references(&p, character) {
            if flag.load(Ordering::Relaxed) {
                return Err("CANCELLED".into());
            }
            let source = project::asset(&r.root, &reference.path)?;
            let sha = crate::voice_library::digest(&source)?;
            let pcm = parent.join(format!("reference-{sha}.wav"));
            if !pcm.is_file()
                || crate::audio_files::pcm_frames(&pcm, 1, 16000, "INVALID_REFERENCE_AUDIO")
                    .is_err()
            {
                let _ = std::fs::remove_file(&pcm);
                crate::separation::process(
                    core,
                    app,
                    key,
                    &ffmpeg,
                    &[
                        "-nostdin".into(),
                        "-v".into(),
                        "error".into(),
                        "-protocol_whitelist".into(),
                        "file,pipe".into(),
                        "-i".into(),
                        source.to_string_lossy().into_owned(),
                        "-t".into(),
                        "20".into(),
                        "-ac".into(),
                        "1".into(),
                        "-ar".into(),
                        "16000".into(),
                        "-c:a".into(),
                        "pcm_s16le".into(),
                        "-n".into(),
                        pcm.to_string_lossy().into_owned(),
                    ],
                    flag,
                )
                .await?;
            }
            enrolled.push(serde_json::json!({"path":pcm,"sha256":sha}));
        }
        if !enrolled.is_empty() {
            characters.push(serde_json::json!({"characterId":character.id,"references":enrolled}));
        }
    }
    let request = folder.join("request.json");
    project::atomic_write(&request,&serde_json::to_vec(&serde_json::json!({"runtime":crate::speakers::root(core),"cache":parent.join("embeddings"),"input":input,"output":output,"characters":characters})).map_err(io_error)?)?;
    crate::separation::process(
        core,
        app,
        key,
        &crate::separation::python(&crate::speakers::root(core)),
        &[
            crate::separation::resources(app)
                .join("character_match_worker.py")
                .to_string_lossy()
                .into_owned(),
            "--request".into(),
            request.to_string_lossy().into_owned(),
        ],
        flag,
    )
    .await?;
    let data: ResultData =
        serde_json::from_slice(&std::fs::read(&output).map_err(io_error)?).map_err(io_error)?;
    validate_result(&p, &data)?;
    let _ = std::fs::remove_file(input);
    let _ = std::fs::remove_file(request);
    Ok(())
}
fn validate_result(p: &Project, data: &ResultData) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    if data.candidates.len() > 3
        || !["matched", "uncertain", "tooShortOrNoSpeech"].contains(&data.reason.as_str())
        || data.candidates.iter().any(|c| {
            !ids.insert(&c.character_id)
                || !p.characters.iter().any(|p| p.id == c.character_id)
                || !c.score.is_finite()
                || !(-1.0..=1.0).contains(&c.score)
        })
    {
        return Err("SPEAKER_ANALYSIS_FAILED".into());
    }
    Ok(())
}
fn stored(core: &Core, key: &str) -> Result<Request, String> {
    core.jobs
        .lock()
        .map_err(io_error)?
        .get(key)
        .filter(|j| j.saved.record.status == "succeeded")
        .and_then(|j| j.saved.character_match.clone())
        .ok_or("SPEAKER_ANALYSIS_FAILED".into())
}
pub fn result(core: &Core, key: String) -> Result<Proposal, String> {
    let r = stored(core, &key)?;
    let path = project::asset(&r.root, &format!("cache/character-match/{key}/result.json"))?;
    let data: ResultData =
        serde_json::from_slice(&std::fs::read(path).map_err(io_error)?).map_err(io_error)?;
    let guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_ref().ok_or("NO_PROJECT")?;
    if s.root != r.root || s.project.id != r.project_id {
        return Err("STALE_REVISION".into());
    }
    let stale =
        !fingerprint(&s.project, &s.root, &r.options).is_ok_and(|actual| actual == r.fingerprint);
    if !stale {
        validate_result(&s.project, &data)?;
    }
    Ok(Proposal {
        id: key,
        line_id: r.options.line_id,
        candidates: data.candidates,
        reason: data.reason,
        reliable: data.reliable,
        stale,
    })
}
pub fn accept<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    key: String,
    character_id: String,
) -> Result<Project, String> {
    let r = stored(core, &key)?;
    let proposal = result(core, key)?;
    if proposal.stale
        || !proposal
            .candidates
            .iter()
            .any(|c| c.character_id == character_id)
    {
        return Err("STALE_REVISION".into());
    }
    let mut guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_mut().ok_or("NO_PROJECT")?;
    if s.root != r.root
        || s.project.id != r.project_id
        || fingerprint(&s.project, &s.root, &r.options)? != r.fingerprint
    {
        return Err("STALE_REVISION".into());
    }
    let mut next = s.project.clone();
    let line = next
        .dialogues
        .iter_mut()
        .find(|l| l.id == r.options.line_id)
        .ok_or("NO_DIALOGUES")?;
    if line.character_id.as_ref() != Some(&character_id) {
        if let Some(options) = line.voice_settings.as_mut() {
            if options.reference_mode == "custom" {
                options.reference_mode = "character".into();
                options.reference_id = None;
            } else if options.reference_mode == "library" {
                options.reference_id = None;
            }
        }
        line.character_id = Some(character_id);
    }
    let saved = s.replace(next, s.project.revision)?;
    app.emit("project-changed", &saved).map_err(io_error)?;
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashMap, sync::Mutex};
    fn fixture(root: &std::path::Path) -> Project {
        let mut p = Project::new("Candidates".into(), "ja".into(), "fr".into());
        p.format_version = 21;
        p.target_cues = serde_json::from_value(
            serde_json::json!([{"id":"target","startMs":0,"endMs":2000,"text":"Bonjour."}]),
        )
        .unwrap();
        p.dialogues = crate::subtitles::align(&[], &p.target_cues);
        p.characters=serde_json::from_value(serde_json::json!([{"id":"a","name":"Personnage 01","color":"#82bda0","references":[{"id":"ref","label":"Original","path":"characters/ref.wav","durationMs":2000,"transcript":"日本語"}],"defaultReferenceId":"ref"},{"id":"b","name":"Personnage 02","color":"#82bda0","references":[],"defaultReferenceId":null}])).unwrap();
        p.tracks=serde_json::from_value(serde_json::json!([{"id":"speech","kind":"audio","role":"speech","path":"stems/speech.wav","durationMs":2000,"sourcePath":null,"language":"ja","mute":false,"solo":false,"gain":1}])).unwrap();
        std::fs::create_dir_all(root.join("characters")).unwrap();
        std::fs::write(
            root.join("characters/ref.wav"),
            b"original reference contents",
        )
        .unwrap();
        p.validate().unwrap();
        p
    }
    #[test]
    fn results_are_review_only_acceptance_is_undoable_and_changed_references_are_stale() {
        let tmp = tempfile::tempdir().unwrap();
        let canonical = tmp.path().canonicalize().unwrap();
        let root = canonical.as_path();
        let p = fixture(root);
        project::save(root, &p).unwrap();
        let options = Options {
            line_id: p.dialogues[0].id.clone(),
            track_id: Some("speech".into()),
        };
        let request = Request {
            root: root.into(),
            project_id: p.id.clone(),
            fingerprint: fingerprint(&p, root, &options).unwrap(),
            options,
        };
        let core = Arc::new(Core {
            session: Mutex::new(Some(project::Session::new(root.into(), p.clone()))),
            jobs: Mutex::new(HashMap::new()),
            gate: Arc::new(tokio::sync::Semaphore::new(1)),
            data_dir: root.into(),
            model_dir: Mutex::new(root.into()),
        });
        let app = tauri::test::mock_app();
        let key = jobs::create(&core, app.handle(), "characterMatch", p.id.clone(), None);
        {
            let mut jobs = core.jobs.lock().unwrap();
            let j = jobs.get_mut(&key).unwrap();
            j.saved.character_match = Some(request);
            j.saved.record.status = "succeeded".into();
        }
        let folder = root.join(format!("cache/character-match/{key}"));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("result.json"),br#"{"candidates":[{"characterId":"a","score":0.95},{"characterId":"b","score":0.8}],"reason":"matched","reliable":true}"#).unwrap();
        let proposal = result(&core, key.clone()).unwrap();
        assert!(!proposal.stale);
        assert_eq!(project::load(root).unwrap().dialogues[0].character_id, None);
        let saved = accept(&core, app.handle(), key.clone(), "a".into()).unwrap();
        assert_eq!(saved.dialogues[0].character_id.as_deref(), Some("a"));
        assert_eq!(saved.generations, p.generations);
        assert!(result(&core, key.clone()).unwrap().stale);
        core.session
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .history(false)
            .unwrap();
        assert_eq!(project::load(root).unwrap().dialogues[0].character_id, None);
        assert!(!result(&core, key.clone()).unwrap().stale);
        std::fs::write(root.join("characters/ref.wav"), b"changed reference").unwrap();
        assert!(result(&core, key.clone()).unwrap().stale);
        assert_eq!(
            accept(&core, app.handle(), key, "a".into()).unwrap_err(),
            "STALE_REVISION"
        );
    }
    #[test]
    fn invalid_unknown_or_unbounded_candidate_results_are_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let p = fixture(tmp.path());
        for (id, score) in [("missing", 0.9), ("a", f64::NAN), ("a", 1.1)] {
            assert!(validate_result(
                &p,
                &ResultData {
                    candidates: vec![Candidate {
                        character_id: id.into(),
                        score
                    }],
                    reason: "matched".into(),
                    reliable: true
                }
            )
            .is_err());
        }
        assert!(validate_result(
            &p,
            &ResultData {
                candidates: vec![],
                reason: "tooShortOrNoSpeech".into(),
                reliable: false
            }
        )
        .is_ok());
    }
}
