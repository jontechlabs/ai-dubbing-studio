//! Per-character, reviewed French voice references. No dialogue take is replaced.
use crate::{
    domain::{id, io_error, now, Project, VoiceReference},
    jobs, project, tts, Core,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub reference_id: Option<String>,
    pub dialogue_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_id: Option<String>,
    pub start_ms: u64,
    pub end_ms: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceOptions {
    pub character_id: String,
    pub label: String,
    pub segments: Vec<Segment>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub reference: VoiceReference,
    pub segments: Vec<Segment>,
    pub sha256: String,
    pub created_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub id: String,
    pub source_id: String,
    pub reference: VoiceReference,
    pub text: String,
    pub mood: String,
    pub status: String,
    pub options: tts::Options,
    pub sha256: String,
    pub created_at: String,
    pub device_name: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub sources: Vec<Source>,
    pub samples: Vec<Sample>,
    pub default_sample_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Phrase {
    pub id: String,
    pub label: String,
    pub text: String,
    pub mood: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Generation {
    pub character_id: String,
    pub source_id: String,
    pub phrases: Vec<Phrase>,
    pub options: tts::Options,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub root: PathBuf,
    pub project_id: String,
    pub generation: Generation,
    pub source_hash: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub character_id: String,
    pub sample_id: String,
    pub status: Option<String>,
    pub transcript: Option<String>,
    pub use_default: bool,
}

pub fn library<'a>(p: &'a Project, owner: &str) -> Option<&'a Library> {
    p.character_profiles.get(owner)?.voice_library.as_ref()
}
fn library_mut<'a>(p: &'a mut Project, owner: &str) -> Result<&'a mut Library, String> {
    if !p.characters.iter().any(|c| c.id == owner) {
        return Err("INVALID_CHARACTER".into());
    }
    p.format_version = p.format_version.max(21);
    Ok(p.character_profiles
        .entry(owner.into())
        .or_default()
        .voice_library
        .get_or_insert_with(Library::default))
}
pub fn reference<'a>(
    p: &'a Project,
    owner: &str,
    selected: Option<&str>,
) -> Option<&'a VoiceReference> {
    let lib = library(p, owner)?;
    let wanted = selected.or(lib.default_sample_id.as_deref())?;
    lib.samples
        .iter()
        .find(|s| s.id == wanted && s.status == "approved")
        .map(|s| &s.reference)
}
pub fn digest(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(io_error)?;
    if file.metadata().map_err(io_error)?.len() > 2 * 1024 * 1024 {
        return Err("INVALID_REFERENCE_AUDIO".into());
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(io_error)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
fn valid_reference(
    r: &VoiceReference,
    sha: &str,
    minimum: u64,
    ids: &mut std::collections::HashSet<String>,
) -> Result<(), String> {
    crate::domain::valid_relative(&r.path)?;
    if r.id.is_empty()
        || !ids.insert(r.id.clone())
        || !r.path.starts_with("characters/voice-library/")
        || !r.path.ends_with(".wav")
        || r.path.len() <= 29
        || r.path[25..r.path.len() - 4]
            .chars()
            .any(|c| !c.is_ascii_alphanumeric() && c != '-')
        || !(minimum..=20000).contains(&r.duration_ms)
        || r.label.trim().is_empty()
        || r.label.len() > 400
        || r.transcript.len() > 16000
        || sha.len() != 64
        || !sha
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return Err("INVALID_VOICE_LIBRARY".into());
    }
    Ok(())
}
pub fn validate(p: &Project) -> Result<(), String> {
    let mut ids = p
        .characters
        .iter()
        .flat_map(|c| c.references.iter())
        .chain(p.voice_references.iter())
        .map(|r| r.id.clone())
        .collect::<std::collections::HashSet<_>>();
    for profile in p.character_profiles.values() {
        let Some(lib) = &profile.voice_library else {
            continue;
        };
        if p.format_version < 21 || lib.sources.len() > 256 || lib.samples.len() > 2000 {
            return Err("INVALID_VOICE_LIBRARY".into());
        }
        let mut sources = std::collections::HashSet::new();
        for source in &lib.sources {
            valid_reference(&source.reference, &source.sha256, 5000, &mut ids)?;
            if source.id != source.reference.id
                || !sources.insert(&source.id)
                || source.created_at.is_empty()
                || !(1..=16).contains(&source.segments.len())
                || source.segments.iter().any(|s| {
                    s.reference_id.is_some() == s.dialogue_id.is_some()
                        || s.end_ms.saturating_sub(s.start_ms) < 100
                })
            {
                return Err("INVALID_VOICE_LIBRARY".into());
            }
        }
        for sample in &lib.samples {
            valid_reference(&sample.reference, &sample.sha256, 1000, &mut ids)?;
            sample.options.validate()?;
            if sample.id != sample.reference.id
                || !sources.contains(&sample.source_id)
                || !["pending", "approved", "rejected"].contains(&sample.status.as_str())
                || sample.text.trim().is_empty()
                || sample.text.chars().count() > 500
                || sample.created_at.is_empty()
                || sample.options.variant() != "voxcpm2-bf16"
                || sample.options.intonation_guide.is_some()
                || sample.options.mood.as_deref() != Some(sample.mood.as_str())
                || (sample.status == "approved" && sample.reference.transcript.trim().is_empty())
            {
                return Err("INVALID_VOICE_LIBRARY".into());
            }
        }
        if lib.default_sample_id.as_ref().is_some_and(|id| {
            !lib.samples
                .iter()
                .any(|s| &s.id == id && s.status == "approved")
        }) {
            return Err("INVALID_VOICE_LIBRARY".into());
        }
    }
    Ok(())
}
pub fn review(p: &Project, options: &Review) -> Result<Project, String> {
    let mut next = p.clone();
    let lib = library_mut(&mut next, &options.character_id)?;
    let sample = lib
        .samples
        .iter_mut()
        .find(|s| s.id == options.sample_id)
        .ok_or("VOICE_LIBRARY_REFERENCE_REQUIRED")?;
    if let Some(transcript) = &options.transcript {
        sample.reference.transcript = transcript.trim().into();
        sample.status = "pending".into();
    }
    if let Some(status) = &options.status {
        if !["pending", "approved", "rejected"].contains(&status.as_str())
            || (status == "approved" && sample.reference.transcript.trim().is_empty())
        {
            return Err("INVALID_VOICE_LIBRARY".into());
        }
        sample.status = status.clone();
    }
    if sample.status != "approved" && lib.default_sample_id.as_ref() == Some(&sample.id) {
        lib.default_sample_id = None;
    }
    if options.use_default {
        if sample.status != "approved" {
            return Err("VOICE_LIBRARY_REFERENCE_REQUIRED".into());
        }
        lib.default_sample_id = Some(sample.id.clone());
    }
    next.validate()?;
    Ok(next)
}

pub async fn prepare<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    options: SourceOptions,
) -> Result<Project, String> {
    if tts::busy(&core) {
        return Err("BUSY".into());
    }
    let _permit = core.gate.clone().try_acquire_owned().map_err(|_| "BUSY")?;
    let (root, p) = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        (s.root.clone(), s.project.clone())
    };
    let owner = p
        .characters
        .iter()
        .find(|c| c.id == options.character_id)
        .ok_or("INVALID_CHARACTER")?;
    if !(1..=16).contains(&options.segments.len())
        || options.label.trim().is_empty()
        || options.label.len() > 400
    {
        return Err("INVALID_REFERENCE_RANGE".into());
    }
    let total = options
        .segments
        .iter()
        .try_fold(0u64, |n, s| {
            n.checked_add(s.end_ms.checked_sub(s.start_ms)?)
        })
        .ok_or("INVALID_REFERENCE_RANGE")?;
    if !(5000..=20000).contains(&total) {
        return Err("VOICE_LIBRARY_SOURCE_DURATION".into());
    }
    let cache = project::ensure_directory(&root, "cache")?;
    let temp = tempfile::tempdir_in(cache).map_err(io_error)?;
    project::ensure_directory(&root, "characters")?;
    project::ensure_directory(&root, "characters/voice-library")?;
    let flag = AtomicBool::new(false);
    let ffmpeg = crate::media::binary(&app, "ffmpeg")?;
    let mut args = vec!["-nostdin".into(), "-v".into(), "error".into()];
    let mut graph = vec![];
    for (i, seg) in options.segments.iter().enumerate() {
        if seg.end_ms.saturating_sub(seg.start_ms) < 100
            || seg.reference_id.is_some() == seg.dialogue_id.is_some()
        {
            return Err("INVALID_REFERENCE_RANGE".into());
        }
        let (input, start, end) = if let Some(id) = &seg.reference_id {
            let r = owner
                .references
                .iter()
                .find(|r| &r.id == id)
                .ok_or("INVALID_REFERENCE_AUDIO")?;
            if seg.end_ms > r.duration_ms {
                return Err("INVALID_REFERENCE_RANGE".into());
            }
            (project::asset(&root, &r.path)?, seg.start_ms, seg.end_ms)
        } else {
            let line = p
                .dialogues
                .iter()
                .find(|l| {
                    Some(&l.id) == seg.dialogue_id.as_ref()
                        && l.character_id.as_ref() == Some(&owner.id)
                })
                .ok_or("INVALID_CHARACTER")?;
            if seg.start_ms < line.start_ms || seg.end_ms > line.end_ms {
                return Err("INVALID_REFERENCE_RANGE".into());
            }
            let track = crate::audio_patch::source_track(&p, seg.track_id.as_deref())?;
            let output = temp.path().join(format!("part-{i}.wav"));
            crate::speaker_dubbing::snippet(
                &core,
                &app,
                "",
                &p,
                &root,
                &line.id,
                crate::audio_patch::Snippet {
                    track_id: &track.id,
                    start_ms: seg.start_ms,
                    end_ms: seg.end_ms,
                    channels: 1,
                    rate: 24000,
                    levels: crate::audio_patch::SnippetLevels::Reference,
                },
                &output,
                &flag,
            )
            .await?;
            (output, 0, seg.end_ms - seg.start_ms)
        };
        args.extend([
            "-protocol_whitelist".into(),
            "file,pipe".into(),
            "-i".into(),
            input.to_string_lossy().into_owned(),
        ]);
        graph.push(format!("[{i}:a:0]atrim=start={:.6}:end={:.6},asetpts=PTS-STARTPTS,aresample=24000,aformat=sample_fmts=s16:channel_layouts=mono[p{i}]",start as f64/1000.,end as f64/1000.));
    }
    graph.push(format!(
        "{}concat=n={}:v=0:a=1[out]",
        (0..options.segments.len())
            .map(|i| format!("[p{i}]"))
            .collect::<String>(),
        options.segments.len()
    ));
    let graph_path = temp.path().join("concat.ffgraph");
    project::atomic_write(&graph_path, graph.join(";\n").as_bytes())?;
    let source_id = id();
    let relative = format!("characters/voice-library/source-{source_id}.wav");
    let output = root.join(&relative);
    args.extend([
        "-/filter_complex".into(),
        graph_path.to_string_lossy().into_owned(),
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
    let mut rendered = false;
    let result = async {
        crate::character_review::direct_process(
            &ffmpeg,
            &args,
            &flag,
            std::time::Duration::from_secs(60),
        )
        .await?;
        let duration =
            crate::audio_files::pcm_frames(&output, 1, 24000, "INVALID_REFERENCE_AUDIO")? * 1000
                / 24000;
        if duration.abs_diff(total) > 4 {
            return Err("INVALID_REFERENCE_AUDIO".into());
        }
        let source = Source {
            id: source_id.clone(),
            reference: VoiceReference {
                id: source_id,
                label: options.label.trim().into(),
                path: relative,
                duration_ms: duration,
                transcript: String::new(),
                source_dialogue_id: None,
            },
            segments: options.segments,
            sha256: digest(&output)?,
            created_at: now(),
        };
        rendered = true;
        let mut guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_mut().ok_or("NO_PROJECT")?;
        if s.root != root || s.project.id != p.id || s.project.revision != p.revision {
            return Err("STALE_REVISION".into());
        }
        let mut next = s.project.clone();
        library_mut(&mut next, &owner.id)?.sources.push(source);
        let updated = s.replace(next, p.revision)?;
        let _ = app.emit("project-changed", &updated);
        Ok(updated)
    }
    .await;
    if result.is_err() && !rendered {
        let _ = std::fs::remove_file(output);
    }
    result
}

fn source<'a>(p: &'a Project, g: &Generation) -> Result<&'a Source, String> {
    if !p.characters.iter().any(|c| c.id == g.character_id) {
        return Err("INVALID_CHARACTER".into());
    }
    library(p, &g.character_id)
        .and_then(|lib| lib.sources.iter().find(|s| s.id == g.source_id))
        .ok_or("VOICE_LIBRARY_REFERENCE_REQUIRED".into())
}
fn source_fingerprint(source: &Source) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(source).map_err(io_error)?)
    ))
}
fn validate_generation(g: &Generation) -> Result<(), String> {
    g.options.validate()?;
    if g.options.variant() != "voxcpm2-bf16"
        || g.options.intonation_guide.is_some()
        || g.options.mode != "crossLingual"
        || !(1..=12).contains(&g.phrases.len())
    {
        return Err("INVALID_VOICE_LIBRARY".into());
    }
    for phrase in &g.phrases {
        if phrase.text.trim().is_empty()
            || phrase.text.chars().count() > 500
            || phrase.label.trim().is_empty()
            || phrase.label.len() > 400
            || crate::voice_mood::spec(Some(&phrase.mood)).is_none()
        {
            return Err("TTS_TEXT_REQUIRED".into());
        }
    }
    Ok(())
}
pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    mut g: Generation,
) -> Result<String, String> {
    validate_generation(&g)?;
    if tts::busy(&core) {
        return Err("BUSY".into());
    }
    if !tts::runtime_installed(&core, &g.options) {
        return Err("TTS_RUNTIME_REQUIRED".into());
    }
    for phrase in &mut g.phrases {
        phrase.id = id();
    }
    let request = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        let source_hash = source_fingerprint(source(&s.project, &g)?)?;
        Request {
            root: s.root.clone(),
            project_id: s.project.id.clone(),
            generation: g,
            source_hash,
        }
    };
    resume(core, app, request)
}
pub fn resume<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    request: Request,
) -> Result<String, String> {
    validate_generation(&request.generation)?;
    if tts::busy(&core) {
        return Err("BUSY".into());
    }
    if !tts::runtime_installed(&core, &request.generation.options) {
        return Err("TTS_RUNTIME_REQUIRED".into());
    }
    {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        if s.root != request.root
            || s.project.id != request.project_id
            || source_fingerprint(source(&s.project, &request.generation)?)? != request.source_hash
        {
            return Err("STALE_REVISION".into());
        }
    }
    let key = jobs::create(
        &core,
        &app,
        "voiceLibrary",
        request.project_id.clone(),
        None,
    );
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .ok_or("INVALID_PROJECT")?
        .saved
        .voice_library = Some(request.clone());
    jobs::persist(&core);
    let returned = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result=async {
            let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),permit=core.gate.clone().acquire_owned()=>permit.map_err(io_error)?};
            let base=crate::voice_engines::root(&core);
            let launch=tts::WorkerLaunch{python:crate::separation::python(&base.join("multilingual-runtime")),script:crate::separation::resources(&app).join("multilingual_worker.py"),model:base.join("voxcpm2-bf16")};
            run(&core,&app,&key,&request,&flag,&launch).await
        }.await;
        crate::separation::finish(&core, &app, &key, &result);
    });
    Ok(returned)
}
pub(crate) async fn run<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    r: &Request,
    flag: &AtomicBool,
    launch: &tts::WorkerLaunch,
) -> Result<(), String> {
    let mut hot = crate::tts_session::Session::default();
    let result = async {
        let mut progress = crate::tts_batch::Progress {
            total: r.generation.phrases.len(),
            ..Default::default()
        };
        let mut failure = None;
        jobs::update(core, app, key, |j| {
            j.status = "running".into();
            j.stage = "voiceLibraryGenerate".into();
            j.progress = None;
            j.batch = Some(progress.clone());
        });
        for phrase in &r.generation.phrases {
            if flag.load(Ordering::Relaxed) {
                return Err("CANCELLED".into());
            }
            if uuid::Uuid::parse_str(&phrase.id).is_err() {
                return Err("INVALID_VOICE_LIBRARY".into());
            }
            let p = {
                let guard = core.session.lock().map_err(io_error)?;
                let s = guard.as_ref().ok_or("NO_PROJECT")?;
                if s.root != r.root || s.project.id != r.project_id {
                    return Err("STALE_REVISION".into());
                }
                s.project.clone()
            };
            let anchor = source(&p, &r.generation)?;
            if source_fingerprint(anchor)? != r.source_hash {
                return Err("STALE_REVISION".into());
            }
            if library(&p, &r.generation.character_id)
                .is_some_and(|lib| lib.samples.iter().any(|s| s.id == phrase.id))
            {
                progress.completed += 1;
                progress.skipped += 1;
                jobs::update(core, app, key, |j| {
                    j.batch = Some(progress.clone());
                    j.progress = Some(progress.completed as f64 / progress.total as f64);
                });
                continue;
            }
            let path = project::asset(&r.root, &anchor.reference.path)?;
            if digest(&path)? != anchor.sha256 {
                return Err("VOICE_LIBRARY_REFERENCE_CHANGED".into());
            }
            let result =
                generate_one(core, app, key, r, phrase, anchor, flag, launch, &mut hot).await;
            if let Err(error) = result {
                // Timeout drops the reader future; explicitly await the child too.
                hot.close_logged(core, app, key).await;
                if flag.load(Ordering::Relaxed) || error == "STALE_REVISION" {
                    return Err(error);
                }
                jobs::update(core, app, key, |j| {
                    j.logs.push(format!("{}: {error}", phrase.label))
                });
                hot.close_logged(core, app, key).await;
                progress.failed += 1;
                failure = Some(error);
            } else {
                progress.succeeded += 1;
            }
            progress.completed += 1;
            jobs::update(core, app, key, |j| {
                j.batch = Some(progress.clone());
                j.progress = Some(progress.completed as f64 / progress.total as f64);
            });
        }
        if let Some(error) = failure {
            Err(error)
        } else {
            Ok(())
        }
    }
    .await;
    hot.close_logged(core, app, key).await;
    result
}
#[allow(clippy::too_many_arguments)]
async fn generate_one<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    r: &Request,
    phrase: &Phrase,
    anchor: &Source,
    flag: &AtomicBool,
    launch: &tts::WorkerLaunch,
    hot: &mut crate::tts_session::Session,
) -> Result<(), String> {
    project::ensure_directory(&r.root, "characters")?;
    let folder = project::ensure_directory(&r.root, "characters/voice-library")?;
    let relative = format!("characters/voice-library/sample-{}-{}.wav", phrase.id, id());
    let output = r.root.join(&relative);
    let request_path = folder.join(format!("request-{key}-{}.json", phrase.id));
    let result_path = folder.join(format!("result-{key}-{}.json", phrase.id));
    let prepared = folder.join(format!("prepared-{key}-{}.wav", phrase.id));
    // Each retry renders a new immutable file; completed sample IDs are skipped above.
    let mut options = r.generation.options.clone();
    options.mood = Some(phrase.mood.clone());
    let input = serde_json::json!({"variantId":"voxcpm2-bf16","quality":options.quality,"text":phrase.text,"promptText":phrase.text,"language":"fr","referenceAudio":project::asset(&r.root,&anchor.reference.path)?,"preparedReferenceAudio":prepared,"referenceTranscript":anchor.reference.transcript,"mode":"crossLingual","mood":options.mood,"accent":options.accent,"speed":options.speed,"seed":options.seed,"device":options.device,"modelDir":launch.model,"outputPath":output,"resultPath":result_path});
    project::atomic_write(
        &request_path,
        &serde_json::to_vec(&input).map_err(io_error)?,
    )?;
    let mut rendered = false;
    let result = async {
        tokio::time::timeout(
            std::time::Duration::from_secs(900),
            hot.generate(core, app, key, launch, &request_path, flag),
        )
        .await
        .map_err(|_| "TTS_TIMEOUT".to_owned())??;
        if flag.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        let duration =
            crate::audio_files::pcm_frames(&output, 1, 24000, "TTS_EMPTY_AUDIO")? * 1000 / 24000;
        if !(1000..=20000).contains(&duration) {
            return Err("VOICE_LIBRARY_SAMPLE_DURATION".into());
        }
        let metadata: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&result_path).map_err(io_error)?)
                .map_err(io_error)?;
        let sample = Sample {
            id: phrase.id.clone(),
            source_id: r.generation.source_id.clone(),
            reference: VoiceReference {
                id: phrase.id.clone(),
                label: phrase.label.clone(),
                path: relative,
                duration_ms: duration,
                transcript: phrase.text.clone(),
                source_dialogue_id: None,
            },
            text: phrase.text.clone(),
            mood: phrase.mood.clone(),
            status: "pending".into(),
            options,
            sha256: digest(&output)?,
            created_at: now(),
            device_name: metadata["deviceName"].as_str().unwrap_or("Unknown").into(),
        };
        rendered = true;
        if digest(&project::asset(&r.root, &anchor.reference.path)?)? != anchor.sha256 {
            return Err("VOICE_LIBRARY_REFERENCE_CHANGED".into());
        }
        let mut guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_mut().ok_or("NO_PROJECT")?;
        if s.root != r.root
            || s.project.id != r.project_id
            || source_fingerprint(source(&s.project, &r.generation)?)? != r.source_hash
        {
            return Err("STALE_REVISION".into());
        }
        let mut next = s.project.clone();
        let lib = library_mut(&mut next, &r.generation.character_id)?;
        if lib.samples.iter().any(|s| s.id == sample.id) {
            return Err("INVALID_VOICE_LIBRARY".into());
        }
        lib.samples.push(sample);
        let updated = s.replace_grouped(next, s.project.revision, Some(key))?;
        let _ = app.emit("project-changed", updated);
        Ok(())
    }
    .await;
    for path in [&request_path, &result_path, &prepared] {
        let _ = std::fs::remove_file(path);
    }
    if result.is_err() && !rendered {
        let _ = std::fs::remove_file(output);
    }
    result
}

#[cfg(test)]
#[path = "voice_library_tests.rs"]
mod tests;
