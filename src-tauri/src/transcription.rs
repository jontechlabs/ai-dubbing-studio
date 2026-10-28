use crate::{domain::io_error, jobs, project, separation, Core};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
};
use tauri::Emitter;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

// Multilingual Whisper small Q5_1, published by whisper.cpp's maintainer (MIT).
// Keep this installation independent of TTS Python environments and GPU drivers.
const MODEL: &str = "ggml-small-q5_1.bin";
const SIZE: u64 = 190085487;
const SHA256: &str = "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb";
const REVISION: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";

#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub root: PathBuf,
    pub project_id: String,
    #[serde(default)]
    pub character_id: Option<String>,
    pub reference_id: String,
    pub language: String,
    pub reference_path: String,
    pub original_transcript: String,
}

pub(crate) fn language_valid(language: &str) -> bool {
    ["auto", "ja", "fr", "en", "zh", "ko", "de", "es", "it", "ru"].contains(&language)
}

fn check_reference<'a>(
    p: &'a crate::domain::Project,
    request: &Request,
) -> Result<&'a crate::domain::VoiceReference, String> {
    let reference = p
        .voice_reference(request.character_id.as_deref(), &request.reference_id)
        .ok_or("TTS_REFERENCE_REQUIRED")?;
    // Do not overwrite a manual correction, a replaced recording, or another project.
    if p.id != request.project_id
        || reference.path != request.reference_path
        || reference.transcript != request.original_transcript
    {
        return Err("STALE_REVISION".into());
    }
    Ok(reference)
}

pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    character_id: Option<String>,
    reference_id: String,
    language: String,
) -> Result<String, String> {
    if !language_valid(&language) {
        return Err("ASR_LANGUAGE_UNSUPPORTED".into());
    }
    if core
        .jobs
        .lock()
        .map_err(io_error)?
        .values()
        .any(|j| ["running", "queued", "paused"].contains(&j.saved.record.status.as_str()))
    {
        return Err("BUSY".into());
    }
    let request = {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        let reference = s
            .project
            .voice_reference(character_id.as_deref(), &reference_id)
            .ok_or("TTS_REFERENCE_REQUIRED")?;
        if reference.duration_ms < 1000 {
            return Err("INVALID_REFERENCE_AUDIO".into());
        }
        project::asset(&s.root, &reference.path)?;
        Request {
            root: s.root.clone(),
            project_id: s.project.id.clone(),
            character_id,
            reference_id,
            language,
            reference_path: reference.path.clone(),
            original_transcript: reference.transcript.clone(),
        }
    };
    let key = jobs::create(
        &core,
        &app,
        "referenceTranscription",
        request.project_id.clone(),
        None,
    );
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .ok_or("INVALID_PROJECT")?
        .saved
        .transcription = Some(request.clone());
    jobs::persist(&core);
    let output = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result = async {
            let _permit = tokio::select! { _ = jobs::cancelled(&flag) => return Err("CANCELLED".into()), permit = core.gate.clone().acquire_owned() => permit.map_err(io_error)?, };
            jobs::update(&core, &app, &key, |job| { job.status = "running".into(); job.stage = "asrModel".into(); job.progress = Some(0.0); job.logs.push("Local transcription: Whisper small multilingual Q5_1, CPU. No audio upload; TTS GPU selection is unchanged.".into()); });
            let model = ensure_model(&core, &app, &key, &flag).await?;
            let input = {
                let session = core.session.lock().map_err(io_error)?;
                let s = session.as_ref().ok_or("NO_PROJECT")?;
                if s.root != request.root { return Err("STALE_REVISION".into()); }
                let reference = check_reference(&s.project, &request)?;
                project::asset(&s.root, &reference.path)?
            };
            let cache = project::ensure_directory(&request.root, "cache")?;
            let temporary = tempfile::Builder::new().prefix("reference-asr-").tempdir_in(cache).map_err(io_error)?;
            let audio = temporary.path().join("reference.f32");
            let result_file = temporary.path().join("transcript.json");
            jobs::update(&core, &app, &key, |job| { job.stage = "asrPrepare".into(); job.progress = None; });
            separation::process(&core, &app, &key, &media_binary(&app)?, &[
                "-hide_banner".into(), "-loglevel".into(), "error".into(), "-nostdin".into(), "-protocol_whitelist".into(), "file,pipe".into(), "-i".into(), input.to_string_lossy().into_owned(), "-map".into(), "0:a:0".into(), "-vn".into(), "-ac".into(), "1".into(), "-ar".into(), "16000".into(), "-t".into(), "20".into(), "-f".into(), "f32le".into(), "-n".into(), audio.to_string_lossy().into_owned()
            ], &flag).await?;
            jobs::update(&core, &app, &key, |job| { job.stage = "asrLoad".into(); job.progress = None; });
            // Isolate native inference in a child process: cancellation kills it and frees RAM.
            let executable = std::env::current_exe().map_err(io_error)?;
            let arguments = [
                "--transcribe-reference".into(), model.to_string_lossy().into_owned(), audio.to_string_lossy().into_owned(), request.language.clone(), result_file.to_string_lossy().into_owned()
            ];
            let process = separation::process(&core, &app, &key, &executable, &arguments, &flag);
            tokio::pin!(process);
            tokio::select! { _ = tokio::time::sleep(std::time::Duration::from_secs(600)) => { flag.store(true, Ordering::Relaxed); let _ = process.await; return Err("ASR_FAILED".into()); }, result = &mut process => result?, }
            if flag.load(Ordering::Relaxed) { return Err("CANCELLED".into()); }
            let result: Transcript = serde_json::from_slice(&std::fs::read(result_file).map_err(io_error)?).map_err(io_error)?;
            let text = valid_transcript(&result.text)?;
            jobs::update(&core, &app, &key, |job| { job.stage = "commit".into(); job.progress = None; });
            let mut session = core.session.lock().map_err(io_error)?;
            let s = session.as_mut().ok_or("NO_PROJECT")?;
            if s.root != request.root { return Err("STALE_REVISION".into()); }
            check_reference(&s.project, &request)?;
            let mut next = s.project.clone();
            let references = match request.character_id.as_deref() {
                Some(owner) => &mut next.characters.iter_mut().find(|c| c.id == owner).ok_or("TTS_REFERENCE_REQUIRED")?.references,
                None => &mut next.voice_references,
            };
            references.iter_mut().find(|r| r.id == request.reference_id).ok_or("TTS_REFERENCE_REQUIRED")?.transcript = text;
            if flag.load(Ordering::Relaxed) { return Err("CANCELLED".into()); }
            let saved = s.replace(next, s.project.revision)?;
            let _ = app.emit("project-changed", saved);
            Ok(())
        }.await;
        separation::finish(&core, &app, &key, &result);
    });
    Ok(output)
}

fn media_binary<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    crate::media::binary(app, "ffmpeg")
}

#[derive(Serialize, Deserialize)]
struct Transcript {
    text: String,
}
pub(crate) fn valid_transcript(text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("ASR_EMPTY_AUDIO".into());
    }
    if text.chars().count() > 10000 {
        return Err("ASR_FAILED".into());
    }
    Ok(text.into())
}

pub fn worker(model: &Path, audio: &Path, language: &str, output: &Path) -> Result<(), String> {
    worker_bounded(model, audio, language, output, 20)
}
pub fn worker_dialogue(
    model: &Path,
    audio: &Path,
    language: &str,
    output: &Path,
) -> Result<(), String> {
    worker_bounded(model, audio, language, output, 120)
}
pub async fn ensure_model<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    flag: &std::sync::atomic::AtomicBool,
) -> Result<PathBuf, String> {
    let root = crate::model_storage::root(core).join("whisper-reference");
    std::fs::create_dir_all(&root).map_err(io_error)?;
    let path = root.join(MODEL);
    if !std::fs::metadata(&path).is_ok_and(|m| m.len() == SIZE)
        && crate::voice_space::available(&root)
            .ok()
            .is_some_and(|b| b < SIZE + 64 * 1024 * 1024)
    {
        return Err("ASR_DISK_REQUIRED".into());
    }
    separation::fetch(
        core,
        app,
        key,
        &[format!(
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/{REVISION}/{MODEL}"
        )],
        &path,
        (SHA256, SIZE),
        flag,
    )
    .await?;
    Ok(path)
}
fn worker_bounded(
    model: &Path,
    audio: &Path,
    language: &str,
    output: &Path,
    max_seconds: usize,
) -> Result<(), String> {
    if !language_valid(language) {
        return Err("ASR_LANGUAGE_UNSUPPORTED".into());
    }
    let bytes = std::fs::read(audio).map_err(io_error)?;
    if bytes.len() % 4 != 0 || !(16000 * 4..=max_seconds * 16000 * 4).contains(&bytes.len()) {
        return Err("INVALID_REFERENCE_AUDIO".into());
    }
    let samples: Vec<f32> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|v| f32::from_le_bytes(*v))
        .collect();
    if samples.iter().any(|sample| !sample.is_finite()) {
        return Err("INVALID_REFERENCE_AUDIO".into());
    }
    if samples.iter().map(|v| v * v).sum::<f32>() / (samples.len() as f32) < 0.00000001 {
        return Err("ASR_EMPTY_AUDIO".into());
    }
    // Read using Rust paths, including Windows Unicode/extended-length storage paths.
    let buffer = std::fs::read(model).map_err(io_error)?;
    if buffer.len() as u64 != SIZE {
        return Err("MODEL_CHECKSUM_FAILED".into());
    }
    let mut context_params = WhisperContextParameters::default();
    context_params.use_gpu(false);
    let context = WhisperContext::new_from_buffer_with_params(&buffer, context_params)
        .map_err(|e| format!("ASR_FAILED: {e}"))?;
    drop(buffer);
    let mut state = context
        .create_state()
        .map_err(|e| format!("ASR_FAILED: {e}"))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 5 });
    params.set_n_threads(std::thread::available_parallelism().map_or(4, |n| n.get().min(8)) as i32);
    params.set_language(if language == "auto" {
        None
    } else {
        Some(language)
    });
    params.set_translate(false);
    params.set_no_context(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_progress_callback_safe(|progress| {
        println!(
            "{}",
            serde_json::json!({"stage":"asrTranscribe","progress":f64::from(progress)/100.0})
        );
    });
    println!(
        "{}",
        serde_json::json!({"stage":"asrTranscribe","progress":null})
    );
    state
        .full(params, &samples)
        .map_err(|e| format!("ASR_FAILED: {e}"))?;
    let mut text = String::new();
    for segment in state.as_iter() {
        if segment.no_speech_probability() < 0.6 {
            text.push_str(segment.to_str().map_err(io_error)?);
        }
    }
    let result = Transcript {
        text: valid_transcript(&text)?,
    };
    project::atomic_write(output, &serde_json::to_vec(&result).map_err(io_error)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires an explicitly supplied local Whisper model and speech fixture"]
    fn real_reference_transcription() {
        let model = PathBuf::from(std::env::var_os("DUBBING_ASR_MODEL").unwrap());
        let audio = PathBuf::from(std::env::var_os("DUBBING_ASR_AUDIO").unwrap());
        let output = PathBuf::from(std::env::var_os("DUBBING_ASR_OUTPUT").unwrap());
        let language = std::env::var("DUBBING_ASR_LANGUAGE").unwrap_or("auto".into());
        worker(&model, &audio, &language, &output).unwrap();
        let result: Transcript = serde_json::from_slice(&std::fs::read(output).unwrap()).unwrap();
        if let Ok(expected) = std::env::var("DUBBING_ASR_EXPECT") {
            assert!(
                result.text.contains(&expected),
                "Unexpected transcript: {}",
                result.text
            );
        }
    }
    #[test]
    fn transcription_stays_in_original_script_and_rejects_empty_results() {
        assert_eq!(
            valid_transcript(" 彼の名前は坂本太郎です。 ").unwrap(),
            "彼の名前は坂本太郎です。"
        );
        assert_eq!(valid_transcript(" \n").unwrap_err(), "ASR_EMPTY_AUDIO");
        assert!(language_valid("auto"));
        assert!(language_valid("ja"));
        assert!(!language_valid("ja;translate"));
    }
    #[test]
    fn a_manual_correction_or_changed_audio_cannot_be_overwritten() {
        let mut p = crate::domain::Project::new("Test".into(), "ja".into(), "fr".into());
        let reference = crate::domain::VoiceReference {
            id: "ref".into(),
            label: "Voice".into(),
            path: "characters/ref.wav".into(),
            duration_ms: 4000,
            transcript: String::new(),
            source_dialogue_id: None,
        };
        p.characters.push(crate::domain::Character {
            id: "speaker".into(),
            name: "A".into(),
            color: "#ffffff".into(),
            references: vec![reference],
            default_reference_id: Some("ref".into()),
        });
        let request = Request {
            root: PathBuf::new(),
            project_id: p.id.clone(),
            character_id: Some("speaker".into()),
            reference_id: "ref".into(),
            language: "auto".into(),
            reference_path: "characters/ref.wav".into(),
            original_transcript: String::new(),
        };
        assert!(check_reference(&p, &request).is_ok());
        p.characters[0].references[0].transcript = "Correction manuelle".into();
        assert_eq!(check_reference(&p, &request).unwrap_err(), "STALE_REVISION");
        p.characters[0].references[0].transcript.clear();
        p.characters[0].references[0].path = "characters/replaced.wav".into();
        assert_eq!(check_reference(&p, &request).unwrap_err(), "STALE_REVISION");
        p.characters[0].references.clear();
        assert!(check_reference(&p, &request).is_err());
    }
    #[test]
    fn silence_does_not_create_a_hallucinated_reference_transcript() {
        let folder = tempfile::tempdir().unwrap();
        let audio = folder.path().join("silence.f32");
        std::fs::write(&audio, vec![0; 16000 * 4]).unwrap();
        assert_eq!(
            worker(
                &folder.path().join("absent-model"),
                &audio,
                "ja",
                &folder.path().join("result.json")
            )
            .unwrap_err(),
            "ASR_EMPTY_AUDIO"
        );
        assert!(!folder.path().join("result.json").exists());
    }
    #[test]
    fn standalone_transcription_keeps_manual_corrections_and_old_character_requests_compatible() {
        let mut p = crate::domain::Project::new("Test".into(), "ja".into(), "fr".into());
        p.voice_references.push(crate::domain::VoiceReference {
            id: "file".into(),
            label: "Audio".into(),
            path: "characters/file.wav".into(),
            duration_ms: 3000,
            transcript: String::new(),
            source_dialogue_id: None,
        });
        let request = Request {
            root: PathBuf::new(),
            project_id: p.id.clone(),
            character_id: None,
            reference_id: "file".into(),
            language: "auto".into(),
            reference_path: "characters/file.wav".into(),
            original_transcript: String::new(),
        };
        assert!(check_reference(&p, &request).is_ok());
        p.voice_references[0].transcript = "Manual correction".into();
        assert_eq!(check_reference(&p, &request).unwrap_err(), "STALE_REVISION");
        let mut legacy = serde_json::to_value(request).unwrap();
        legacy["character_id"] = "speaker".into();
        assert_eq!(
            serde_json::from_value::<Request>(legacy)
                .unwrap()
                .character_id
                .as_deref(),
            Some("speaker")
        );
    }
}
