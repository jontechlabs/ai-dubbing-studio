mod audio_edit;
mod audio_effects;
mod audio_files;
mod audio_fx_job;
mod audio_patch;
mod audio_toolbox;
mod character_match;
mod character_review;
mod domain;
mod downloads;
mod dubbing_pipeline;
mod embedded;
mod face_detection;
mod graphics;
mod inpaint;
mod inpaint_batch;
#[cfg(test)]
mod integration_tests;
mod jobs;
mod joint_review;
mod lips;
mod local_separation;
mod mcp;
mod media;
mod mix;
mod model_storage;
mod project;
mod prosody;
mod qwen_safety;
mod separation;
mod smoke;
mod source_transcription;
mod speakers;
mod subtitles;
mod transcription;
mod translation_llm;
mod tts;
mod tts_batch;
mod tts_session;
mod voice_accent;
mod voice_capture;
mod voice_edit;
mod voice_engines;
mod voice_fit;
mod voice_library;
mod voice_mood;
mod voice_quality;
mod voice_space;
mod waveform;
pub fn smoke_test(path: &std::path::Path) -> Result<(), String> {
    smoke::run(path)
}
pub fn mcp_stdio(path: &std::path::Path) -> Result<(), String> {
    mcp::stdio(path)
}

#[tauri::command]
fn mcp_status(control: tauri::State<'_, Arc<mcp::Controller>>) -> serde_json::Value {
    control.status()
}
#[tauri::command]
fn mcp_prepare_update(
    core: State<'_, Shared>,
    control: tauri::State<'_, Arc<mcp::Controller>>,
) -> Result<(), String> {
    if core
        .jobs
        .lock()
        .map_err(domain::io_error)?
        .values()
        .any(|j| {
            matches!(
                j.saved.record.status.as_str(),
                "queued" | "running" | "paused"
            )
        })
    {
        return Err("BUSY".into());
    }
    // Keep mcp-enabled intact, so the new version restores the user's choice.
    control.stop();
    Ok(())
}
#[tauri::command]
fn mcp_update_failed(control: tauri::State<'_, Arc<mcp::Controller>>) {
    control.restore();
}
#[tauri::command]
async fn mcp_set_enabled(
    control: tauri::State<'_, Arc<mcp::Controller>>,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    let control = control.inner().clone();
    tauri::async_runtime::spawn_blocking(move || control.set_enabled(enabled))
        .await
        .map_err(domain::io_error)?
}

#[tauri::command]
async fn mcp_store_microphone_take(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    request: tauri::ipc::Request<'_>,
) -> Result<Project, String> {
    let capture: voice_capture::Capture = serde_json::from_str(
        request
            .headers()
            .get("x-studio-capture")
            .ok_or("MIC_INVALID_AUDIO")?
            .to_str()
            .map_err(domain::io_error)?,
    )
    .map_err(domain::io_error)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("MIC_INVALID_AUDIO".into());
    };
    if bytes.len() > 44 + 120000 * 48 {
        return Err("MIC_INVALID_AUDIO".into());
    }
    let bytes = bytes.clone();
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        voice_capture::save_microphone(core, app, capture, &bytes)
    })
    .await
    .map_err(domain::io_error)?
}
#[tauri::command]
fn convert_voice_timbre(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    options: voice_capture::Options,
) -> Result<String, String> {
    voice_capture::start(core.inner().clone(), app, options)
}
#[tauri::command]
fn prosody_status(app: tauri::AppHandle) -> serde_json::Value {
    prosody::status(&app)
}
#[tauri::command]
fn transfer_voice_prosody(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    options: prosody::Options,
) -> Result<String, String> {
    prosody::start(core.inner().clone(), app, options)
}
#[tauri::command]
fn mcp_ready(control: tauri::State<'_, Arc<mcp::Controller>>, ready: bool) {
    control.set_ready(ready);
}
#[tauri::command]
fn mcp_claim(
    control: tauri::State<'_, Arc<mcp::Controller>>,
    id: String,
) -> Result<Option<mcp::Request>, String> {
    control.claim(&id)
}
#[tauri::command]
fn mcp_live(control: tauri::State<'_, Arc<mcp::Controller>>, id: String) -> bool {
    control.live(&id)
}
#[tauri::command]
fn mcp_complete(
    control: tauri::State<'_, Arc<mcp::Controller>>,
    id: String,
    result: Option<serde_json::Value>,
    error: Option<String>,
) {
    control.complete(&id, result, error);
}
pub fn transcribe_reference_worker(
    model: &Path,
    audio: &Path,
    language: &str,
    output: &Path,
) -> Result<(), String> {
    transcription::worker(model, audio, language, output)
}
pub fn transcribe_dialogue_worker(
    model: &Path,
    audio: &Path,
    language: &str,
    output: &Path,
) -> Result<(), String> {
    transcription::worker_dialogue(model, audio, language, output)
}
#[tauri::command]
fn transcribe_dialogue_source(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    options: source_transcription::Options,
) -> Result<String, String> {
    source_transcription::enqueue(core.inner().clone(), app, options)
}
#[tauri::command]
fn source_transcription_result(
    core: State<'_, Shared>,
    id: String,
) -> Result<Option<source_transcription::Proposal>, String> {
    source_transcription::result(&core, &id)
}
#[tauri::command]
fn latest_source_transcription(
    core: State<'_, Shared>,
    line_id: String,
) -> Result<Option<String>, String> {
    source_transcription::latest(&core, &line_id)
}
#[tauri::command]
fn generate_dubbing_pipeline(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    options: dubbing_pipeline::Options,
) -> Result<String, String> {
    dubbing_pipeline::start(core.inner().clone(), app, options)
}
#[tauri::command]
async fn audio_toolbox_status(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
) -> Result<serde_json::Value, String> {
    audio_toolbox::status(core.inner().clone(), app).await
}
#[tauri::command]
fn install_audio_toolbox_model(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    model_id: String,
) -> Result<String, String> {
    audio_toolbox::install(core.inner().clone(), app, model_id)
}
#[tauri::command]
fn separate_audio_selection(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    options: audio_toolbox::Options,
) -> Result<String, String> {
    audio_toolbox::start(core.inner().clone(), app, options)
}
#[tauri::command]
fn audio_toolbox_result(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    id: String,
) -> Result<serde_json::Value, String> {
    audio_toolbox::result(&core, &app, &id)
}
#[tauri::command]
fn audio_toolbox_path(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    id: String,
    output_id: String,
) -> Result<String, String> {
    audio_toolbox::path(&core, &app, &id, &output_id)
}
#[tauri::command]
async fn apply_audio_toolbox_result(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    id: String,
    destinations: Vec<audio_toolbox::Destination>,
    mute_source: bool,
) -> Result<Project, String> {
    audio_toolbox::apply(core.inner().clone(), app, id, destinations, mute_source).await
}
#[tauri::command]
fn apply_source_transcription(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    id: String,
    texts: Vec<String>,
) -> Result<Project, String> {
    source_transcription::apply(&core, &app, id, texts)
}
#[tauri::command]
async fn set_voice_output_gain(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    id: String,
    gain: f64,
) -> Result<Project, String> {
    voice_edit::set_output_gain(core.inner().clone(), app, id, gain).await
}

use domain::{io_error, MediaAsset, MediaInfo, Project};
use jobs::{Control, ImportRequest, Job, PersistedJob};
use project::Session;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, Manager, State};

pub struct Core {
    session: Mutex<Option<Session>>,
    jobs: Mutex<HashMap<String, Control>>,
    gate: Arc<tokio::sync::Semaphore>,
    data_dir: PathBuf,
    model_dir: Mutex<PathBuf>,
}
type Shared = Arc<Core>;
#[tauri::command]
async fn translation_status(core: State<'_, Shared>) -> Result<translation_llm::Status, String> {
    translation_llm::status(core.inner().clone()).await
}
#[tauri::command]
fn install_translation_model(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
) -> Result<String, String> {
    translation_llm::install(core.inner().clone(), app)
}
#[tauri::command]
fn suggest_translation(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    line_id: String,
    device: String,
    direction: Option<String>,
) -> Result<String, String> {
    translation_llm::enqueue(
        core.inner().clone(),
        app,
        line_id,
        device,
        direction.unwrap_or_default(),
    )
}
#[tauri::command]
fn translation_result(
    core: State<'_, Shared>,
    id: String,
) -> Result<Option<translation_llm::Proposal>, String> {
    translation_llm::result(&core, &id)
}
#[tauri::command]
fn latest_translation(core: State<'_, Shared>, line_id: String) -> Result<Option<String>, String> {
    translation_llm::latest(&core, &line_id)
}
#[tauri::command]
fn analyze_lips(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    options: lips::Options,
) -> Result<String, String> {
    lips::enqueue(core.inner().clone(), app, options)
}
#[tauri::command]
async fn inpaint_status(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    model_id: Option<String>,
) -> Result<serde_json::Value, String> {
    inpaint::status(
        core.inner().clone(),
        app,
        model_id.as_deref().unwrap_or(inpaint::MUSE),
    )
    .await
}
#[tauri::command]
fn install_inpaint(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    model_id: Option<String>,
) -> Result<String, String> {
    inpaint::install_model(
        core.inner().clone(),
        app,
        model_id.as_deref().unwrap_or(inpaint::MUSE),
    )
}
#[tauri::command]
fn inpaint_lips(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    options: inpaint::Options,
) -> Result<String, String> {
    inpaint::enqueue(core.inner().clone(), app, options)
}
#[tauri::command]
fn inpaint_path(core: State<'_, Shared>, id: String) -> Result<String, String> {
    inpaint::media_path(&core, &id)
}
#[tauri::command]
fn preview_inpaint_batch(
    core: State<'_, Shared>,
    selection: inpaint_batch::Selection,
) -> Result<inpaint_batch::Preview, String> {
    let guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_ref().ok_or("NO_PROJECT")?;
    inpaint_batch::plan(&s.project, &s.root, &selection).map(|(preview, _)| preview)
}
#[tauri::command]
fn start_inpaint_batch(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    selection: inpaint_batch::Selection,
) -> Result<String, String> {
    inpaint_batch::enqueue(core.inner().clone(), app, selection)
}
#[tauri::command]
fn detect_inpaint_faces(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    selection: inpaint_batch::Selection,
    profile: String,
) -> Result<String, String> {
    face_detection::enqueue(core.inner().clone(), app, selection, profile)
}
#[tauri::command]
fn face_detection_result(
    core: State<'_, Shared>,
    id: String,
) -> Result<Option<face_detection::ResultSet>, String> {
    face_detection::result(&core, &id)
}
#[tauri::command]
fn transfer_audio(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    options: audio_patch::Options,
) -> Result<String, String> {
    audio_patch::enqueue(core.inner().clone(), app, options)
}
#[tauri::command]
fn audio_patch_path(core: State<'_, Shared>, id: String) -> Result<String, String> {
    audio_patch::path(&core, &id)
}
#[tauri::command]
fn lip_analysis_result(
    core: State<'_, Shared>,
    id: String,
) -> Result<Option<lips::Analysis>, String> {
    lips::result(&core, &id)
}
#[tauri::command]
fn latest_lip_analysis(
    core: State<'_, Shared>,
    line_id: String,
    generation_id: String,
) -> Result<Option<String>, String> {
    lips::latest(&core, &line_id, &generation_id)
}
#[tauri::command]
fn export_mkv(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    path: String,
    options: mix::Options,
) -> Result<String, String> {
    mix::enqueue(core.inner().clone(), app, PathBuf::from(path), options)
}
#[tauri::command]
async fn voice_status(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    include_cuda: Option<bool>,
) -> Result<serde_json::Value, String> {
    voice_engines::status(core.inner().clone(), app, include_cuda.unwrap_or(false)).await
}
#[tauri::command]
async fn voice_install_space(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    variant_id: Option<String>,
) -> Result<voice_space::Space, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        voice_space::check_variant(
            &core,
            &app,
            variant_id.as_deref().unwrap_or("drama3-comfy-fp8"),
        )
    })
    .await
    .map_err(domain::io_error)?
}
#[tauri::command]
fn install_voice_runtime(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    variant_id: String,
) -> Result<String, String> {
    voice_engines::install(core.inner().clone(), app, variant_id)
}
#[tauri::command]
async fn tts_status(app: tauri::AppHandle, core: State<'_, Shared>) -> Result<tts::Status, String> {
    tts::status(core.inner().clone(), app).await
}
#[tauri::command]
fn install_tts_runtime(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    cuda: bool,
) -> Result<String, String> {
    tts::install(core.inner().clone(), app, cuda)
}
#[tauri::command]
fn generate_line(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    line_id: String,
    options: tts::Options,
) -> Result<String, String> {
    tts::enqueue(core.inner().clone(), app, line_id, options)
}
#[tauri::command]
async fn dubbing_path(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    id: String,
    slot_ms: u64,
    exact_duration: Option<bool>,
    edit: Option<voice_edit::Edit>,
) -> Result<String, String> {
    if slot_ms > voice_edit::MAX_DURATION_MS {
        return Err("VOICE_DURATION_OUT_OF_RANGE".into());
    }
    let (root, path) = {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        if slot_ms == 0
            || slot_ms
                > s.project
                    .media
                    .as_ref()
                    .ok_or("MEDIA_MISSING")?
                    .info
                    .duration_ms
        {
            return Err("MIX_SLOT_CONFLICT".into());
        }
        let generation = s
            .project
            .generations
            .iter()
            .find(|g| g["id"] == id && g["kind"] == "tts")
            .ok_or("INVALID_GENERATION")?;
        (
            s.root.clone(),
            generation["path"]
                .as_str()
                .ok_or("INVALID_GENERATION")?
                .to_owned(),
        )
    };
    // Timings may still be in the editor's autosave queue. The renderer supplies
    // its current slot, while the native side owns and validates every file path.
    let ffmpeg = media::binary(&app, "ffmpeg")?;
    let flag = AtomicBool::new(false);
    let edited = voice_edit::render(&root, &path, edit.as_ref(), &ffmpeg, &flag).await?;
    let relative = edited
        .strip_prefix(&root)
        .map_err(io_error)?
        .to_string_lossy()
        .replace('\\', "/");
    let path = voice_fit::take_with_duration(
        &root,
        &relative,
        slot_ms,
        exact_duration.unwrap_or(false),
        &media::binary(&app, "ffmpeg")?,
        &AtomicBool::new(false),
    )
    .await?;
    Ok(path.to_string_lossy().into_owned())
}
#[tauri::command]
async fn generation_path(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    id: String,
    edit: Option<voice_edit::Edit>,
) -> Result<String, String> {
    let (root, path) = {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        let g = s
            .project
            .generations
            .iter()
            .find(|g| g["id"] == id && g["kind"] == "tts")
            .ok_or("INVALID_GENERATION")?;
        (
            s.root.clone(),
            g["path"].as_str().ok_or("INVALID_GENERATION")?.to_owned(),
        )
    };
    Ok(voice_edit::render(
        &root,
        &path,
        edit.as_ref(),
        &media::binary(&app, "ffmpeg")?,
        &AtomicBool::new(false),
    )
    .await?
    .to_string_lossy()
    .into_owned())
}
#[tauri::command]
async fn export_generation(
    app: tauri::AppHandle,
    edit: Option<voice_edit::Edit>,
    core: State<'_, Shared>,
    id: String,
    path: String,
) -> Result<(), String> {
    let (root, source_path) = {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        let g = s
            .project
            .generations
            .iter()
            .find(|g| g["id"] == id && g["kind"] == "tts")
            .ok_or("INVALID_GENERATION")?;
        (
            s.root.clone(),
            g["path"].as_str().ok_or("INVALID_GENERATION")?.to_owned(),
        )
    };
    let rendered = voice_edit::render(
        &root,
        &source_path,
        edit.as_ref(),
        &media::binary(&app, "ffmpeg")?,
        &AtomicBool::new(false),
    )
    .await?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        if s.root != root {
            return Err("STALE_REVISION".into());
        }
        let generation = s
            .project
            .generations
            .iter()
            .find(|g| g["id"] == id)
            .ok_or("INVALID_GENERATION")?;
        let source = project::asset(
            &s.root,
            generation["path"].as_str().ok_or("INVALID_GENERATION")?,
        )?;
        let output = PathBuf::from(path);
        let parent = output
            .parent()
            .ok_or("INVALID_PATH")?
            .canonicalize()
            .map_err(io_error)?;
        if parent.starts_with(&s.root) && parent != s.root.join("exports") {
            return Err("INVALID_PATH".into());
        }
        if output.exists() && output.canonicalize().map_err(io_error)? == source {
            return Err("INVALID_PATH".into());
        }
        project::atomic_write(
            &parent.join(output.file_name().ok_or("INVALID_PATH")?),
            &std::fs::read(rendered).map_err(io_error)?,
        )
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
fn model_storage_info(core: State<'_, Shared>) -> Result<model_storage::Info, String> {
    model_storage::info(&core)
}
#[tauri::command]
async fn model_storage_size(core: State<'_, Shared>) -> Result<model_storage::Size, String> {
    let path = model_storage::root(&core);
    tauri::async_runtime::spawn_blocking(move || model_storage::directory_size(&path))
        .await
        .map_err(io_error)?
}
#[tauri::command]
fn change_model_storage(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    path: String,
) -> Result<String, String> {
    model_storage::change(core.inner().clone(), app, PathBuf::from(path))
}
#[tauri::command]
fn speaker_status(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
) -> Result<speakers::Status, String> {
    speakers::status(&core, &app)
}
#[tauri::command]
fn install_speaker_runtime(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
) -> Result<String, String> {
    speakers::install(core.inner().clone(), app)
}
#[tauri::command]
fn identify_speakers(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    threshold: f64,
    scope: Option<character_review::Scope>,
) -> Result<String, String> {
    if let Some(scope) = scope {
        speakers::enqueue_scope(core.inner().clone(), app, threshold, scope)
    } else {
        speakers::enqueue(core.inner().clone(), app, threshold)
    }
}
#[tauri::command]
fn character_asset_path(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    path: String,
) -> Result<String, String> {
    let path = character_review::asset(&core, &path)?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(io_error)?;
    Ok(path)
}
#[tauri::command]
async fn capture_character_portrait(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    options: character_review::PortraitOptions,
) -> Result<Project, String> {
    character_review::capture_portrait(core.inner().clone(), app, options).await
}
#[tauri::command]
fn suggest_dialogue_character(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    options: character_match::Options,
) -> Result<String, String> {
    character_match::enqueue(core.inner().clone(), app, options)
}
#[tauri::command]
fn character_suggestion_result(
    core: State<'_, Shared>,
    id: String,
) -> Result<character_match::Proposal, String> {
    character_match::result(&core, id)
}
#[tauri::command]
fn accept_character_suggestion(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    id: String,
    character_id: String,
) -> Result<Project, String> {
    character_match::accept(&core, &app, id, character_id)
}
#[tauri::command]
async fn prepare_voice_library_source(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    options: voice_library::SourceOptions,
) -> Result<Project, String> {
    voice_library::prepare(core.inner().clone(), app, options).await
}
#[tauri::command]
fn generate_voice_library(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    options: voice_library::Generation,
) -> Result<String, String> {
    voice_library::enqueue(core.inner().clone(), app, options)
}
#[tauri::command]
fn review_voice_library_sample(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    options: voice_library::Review,
) -> Result<Project, String> {
    let mut guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_mut().ok_or("NO_PROJECT")?;
    let next = voice_library::review(&s.project, &options)?;
    let saved = s.replace(next, s.project.revision)?;
    app.emit("project-changed", &saved).map_err(io_error)?;
    Ok(saved)
}
#[tauri::command]
fn voice_library_audio_path(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    character_id: String,
    reference_id: String,
) -> Result<String, String> {
    let guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_ref().ok_or("NO_PROJECT")?;
    let lib = voice_library::library(&s.project, &character_id)
        .ok_or("VOICE_LIBRARY_REFERENCE_REQUIRED")?;
    let r = lib
        .sources
        .iter()
        .map(|s| &s.reference)
        .chain(lib.samples.iter().map(|s| &s.reference))
        .find(|r| r.id == reference_id)
        .ok_or("VOICE_LIBRARY_REFERENCE_REQUIRED")?;
    let path = project::asset(&s.root, &r.path)?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(io_error)?;
    Ok(path.to_string_lossy().into_owned())
}
#[tauri::command]
async fn prepare_character_reference(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    segments: Vec<character_review::ReferenceSegment>,
    label: String,
) -> Result<domain::VoiceReference, String> {
    character_review::combine_reference(core.inner().clone(), app, segments, label).await
}
#[tauri::command]
async fn preview_character_sample(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    line_id: String,
    track_id: Option<String>,
) -> Result<String, String> {
    let path =
        character_review::preview_sample(core.inner().clone(), app.clone(), line_id, track_id)
            .await?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(io_error)?;
    Ok(path)
}
#[tauri::command]
fn separate_audio_region(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    options: local_separation::Options,
) -> Result<String, String> {
    local_separation::enqueue(core.inner().clone(), app, options)
}
#[tauri::command]
fn local_separation_result(
    core: State<'_, Shared>,
    id: String,
) -> Result<local_separation::Proposal, String> {
    local_separation::result(&core, &id)
}
#[tauri::command]
fn local_separation_path(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    id: String,
    role: String,
) -> Result<String, String> {
    local_separation::path(&core, &app, &id, &role)
}
#[tauri::command]
async fn apply_local_separation(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    id: String,
) -> Result<Project, String> {
    local_separation::apply(core.inner().clone(), app, id).await
}
#[tauri::command]
async fn import_voice_reference(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    character_id: String,
    line_id: Option<String>,
    path: Option<String>,
    label: String,
    range: Option<speakers::ReferenceSpan>,
) -> Result<Project, String> {
    speakers::reference(
        core.inner().clone(),
        app,
        speakers::ReferenceTarget::Character(character_id),
        line_id,
        path.map(|path| speakers::ReferenceFile { path, range }),
        label,
    )
    .await
}
#[tauri::command]
async fn import_dubbing_reference(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    line_id: Option<String>,
    path: String,
    options: tts::Options,
    range: Option<speakers::ReferenceSpan>,
) -> Result<Project, String> {
    let label = std::path::Path::new(&path)
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("Audio")
        .to_owned();
    speakers::reference(
        core.inner().clone(),
        app,
        speakers::ReferenceTarget::Dialogue {
            line_id,
            options: Box::new(options),
        },
        None,
        Some(speakers::ReferenceFile { path, range }),
        label,
    )
    .await
}
#[tauri::command]
async fn reference_audio_info(
    app: tauri::AppHandle,
    path: String,
) -> Result<serde_json::Value, String> {
    let path = std::path::PathBuf::from(path)
        .canonicalize()
        .map_err(io_error)?;
    let info = media::probe_audio(&app, &path).await?;
    if info.duration_ms < 1000 || !info.streams.iter().any(|s| s.kind == "audio") {
        return Err("INVALID_REFERENCE_AUDIO".into());
    }
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(io_error)?;
    Ok(serde_json::json!({"path":path,"durationMs":info.duration_ms}))
}
#[tauri::command]
fn preview_dubbing_batch(
    core: State<'_, Shared>,
    selection: tts_batch::Selection,
) -> Result<tts_batch::Preview, String> {
    tts_batch::preview(&core, &selection)
}
#[tauri::command]
fn generate_dubbing_batch(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    selection: tts_batch::Selection,
) -> Result<String, String> {
    tts_batch::enqueue(core.inner().clone(), app, selection)
}
#[tauri::command]
fn voice_reference_path(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    character_id: Option<String>,
    reference_id: String,
) -> Result<String, String> {
    let session = core.session.lock().map_err(io_error)?;
    let s = session.as_ref().ok_or("NO_PROJECT")?;
    let reference = s
        .project
        .voice_reference(character_id.as_deref(), &reference_id)
        .ok_or("INVALID_REFERENCE_AUDIO")?;
    let path = project::asset(&s.root, &reference.path)?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(io_error)?;
    Ok(path.to_string_lossy().into_owned())
}
#[tauri::command]
fn transcribe_voice_reference(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    character_id: Option<String>,
    reference_id: String,
    language: String,
) -> Result<String, String> {
    transcription::enqueue(
        core.inner().clone(),
        app,
        character_id,
        reference_id,
        language,
    )
}
fn ensure_idle(core: &Core) -> Result<(), String> {
    if jobs::active_processing(core) {
        Err("BUSY".into())
    } else {
        Ok(())
    }
}
fn attach(
    app: &tauri::AppHandle,
    core: &Core,
    root: PathBuf,
    p: Project,
) -> Result<Project, String> {
    app.asset_protocol_scope()
        .allow_directory(&root, true)
        .map_err(io_error)?;
    project::atomic_write(
        &core.data_dir.join("recent.txt"),
        root.to_string_lossy().as_bytes(),
    )?;
    *core.session.lock().map_err(io_error)? = Some(Session::new(root, p.clone()));
    Ok(p)
}
#[tauri::command]
async fn create_project(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    parent_path: String,
    name: String,
    source: String,
    target: String,
) -> Result<Project, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        ensure_idle(&core)?;
        let root = project::create_root(Path::new(&parent_path), &name)?;
        let p = Project::new(name, source, target);
        project::save(&root, &p)?;
        attach(&app, &core, root, p)
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
async fn open_project(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    path: String,
) -> Result<Project, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        ensure_idle(&core)?;
        let root = PathBuf::from(path).canonicalize().map_err(io_error)?;
        let p = project::load(&root)?;
        attach(&app, &core, root, p)
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
async fn restore_project(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
) -> Result<Option<Project>, String> {
    let path = match std::fs::read_to_string(core.data_dir.join("recent.txt")) {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };
    open_project(app, core, path).await.map(Some)
}
#[tauri::command]
async fn replace_project(
    core: State<'_, Shared>,
    project: Project,
    expected_revision: u64,
) -> Result<Project, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        ensure_idle(&core)?;
        core.session
            .lock()
            .map_err(io_error)?
            .as_mut()
            .ok_or("NO_PROJECT")?
            .replace(project, expected_revision)
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
async fn history(core: State<'_, Shared>, direction: String) -> Result<Project, String> {
    if !["undo", "redo"].contains(&direction.as_str()) {
        return Err("INVALID_PROJECT".into());
    }
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        ensure_idle(&core)?;
        core.session
            .lock()
            .map_err(io_error)?
            .as_mut()
            .ok_or("NO_PROJECT")?
            .history(direction == "redo")
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
async fn probe_media(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    path: String,
) -> Result<MediaInfo, String> {
    let core = core.inner().clone();
    let key = jobs::create(&core, &app, "probe", String::new(), None);
    let _permit = core.gate.clone().acquire_owned().await.map_err(io_error)?;
    let flag = core
        .jobs
        .lock()
        .map_err(io_error)?
        .get(&key)
        .ok_or("INVALID_PROJECT")?
        .cancel
        .clone();
    jobs::update(&core, &app, &key, |j| {
        j.status = "running".into();
        j.logs.push(format!(
            "ffprobe args: -v error -protocol_whitelist file,pipe -of json -show_format -show_streams {path:?}"
        ));
    });
    let result = tokio::select! { _ = jobs::cancelled(&flag) => Err("CANCELLED".into()), result = media::probe(&app, Path::new(&path)) => result };
    jobs::update(&core, &app, &key, |j| match &result {
        Ok(_) => {
            j.status = "succeeded".into();
            j.progress = Some(1.0);
        }
        Err(e) => {
            j.status = if e == "CANCELLED" {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            j.error = Some(e.clone());
        }
    });
    result
}
#[tauri::command]
fn import_media(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    path: String,
    audio_stream_index: Option<u32>,
    force_proxy: bool,
) -> Result<String, String> {
    ensure_idle(&core)?;
    let source = PathBuf::from(path).canonicalize().map_err(io_error)?;
    if !source.is_file() {
        return Err("INVALID_PATH".into());
    }
    let session = core.session.lock().map_err(io_error)?;
    let s = session.as_ref().ok_or("NO_PROJECT")?;
    let request = ImportRequest {
        lightweight: true,
        path: source,
        root: s.root.clone(),
        project_id: s.project.id.clone(),
        audio_index: audio_stream_index,
        force_proxy,
        reuse: None,
    };
    Ok(jobs::enqueue(core.inner().clone(), app, request))
}
#[tauri::command]
fn prepare_proxy(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    lightweight: Option<bool>,
) -> Result<String, String> {
    ensure_idle(&core)?;
    let session = core.session.lock().map_err(io_error)?;
    let s = session.as_ref().ok_or("NO_PROJECT")?;
    let media = s.project.media.clone().ok_or("MEDIA_MISSING")?;
    let request = ImportRequest {
        lightweight: lightweight.unwrap_or(true),
        path: project::asset(&s.root, &media.path)?,
        root: s.root.clone(),
        project_id: s.project.id.clone(),
        audio_index: media.audio_stream_index,
        force_proxy: true,
        reuse: Some(media),
    };
    Ok(jobs::enqueue(core.inner().clone(), app, request))
}
#[tauri::command]
async fn import_subtitles(
    core: State<'_, Shared>,
    path: String,
    role: String,
) -> Result<Project, String> {
    if !["source", "target"].contains(&role.as_str()) {
        return Err("INVALID_PROJECT".into());
    }
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        ensure_idle(&core)?;
        let text = std::fs::read_to_string(&path).map_err(io_error)?;
        let mut session = core.session.lock().map_err(io_error)?;
        let s = session.as_mut().ok_or("NO_PROJECT")?;
        s.import_subtitles(&text, &role)
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
async fn import_embedded_subtitles(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    stream_index: u32,
    role: String,
) -> Result<Project, String> {
    ensure_idle(&core)?;
    embedded::import(core.inner().clone(), app, stream_index, &role).await
}
#[tauri::command]
fn media_path(core: State<'_, Shared>) -> Result<String, String> {
    let session = core.session.lock().map_err(io_error)?;
    let s = session.as_ref().ok_or("NO_PROJECT")?;
    let media = s.project.media.as_ref().ok_or("MEDIA_MISSING")?;
    project::asset(
        &s.root,
        media.preview_path.as_deref().unwrap_or(&media.path),
    )
    .map(|p| p.to_string_lossy().into_owned())
}
#[tauri::command]
async fn get_waveform(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    track_id: Option<String>,
) -> Result<Option<waveform::Waveform>, String> {
    waveform::get(core.inner().clone(), app, track_id.as_deref()).await
}
#[tauri::command]
async fn export_subtitles(
    core: State<'_, Shared>,
    path: String,
    role: String,
) -> Result<(), String> {
    if !["source", "target"].contains(&role.as_str()) {
        return Err("INVALID_PROJECT".into());
    }
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        let output = PathBuf::from(path);
        let parent = output
            .parent()
            .ok_or("INVALID_PATH")?
            .canonicalize()
            .map_err(io_error)?;
        if parent.starts_with(&s.root) && !parent.starts_with(s.root.join("exports")) {
            return Err("INVALID_PATH".into());
        }
        let content = subtitles::export_srt(if role == "source" {
            &s.project.source_cues
        } else {
            &s.project.target_cues
        });
        project::atomic_write(&output, content.as_bytes())
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
fn environment(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({ "platform": std::env::consts::OS, "ffmpeg": media::binary(&app, "ffmpeg").is_ok(), "ffprobe": media::binary(&app, "ffprobe").is_ok() })
}
#[tauri::command]
async fn graphics_info() -> Result<graphics::GraphicsInfo, String> {
    graphics::info().await
}
#[tauri::command]
fn set_graphics_preference(choice: String) -> Result<(), String> {
    graphics::set(&choice)
}
#[tauri::command]
fn open_graphics_settings() -> Result<(), String> {
    graphics::open_settings()
}
#[tauri::command]
async fn separation_status(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
) -> Result<separation::Status, String> {
    separation::status(core.inner().clone(), app).await
}
#[tauri::command]
fn install_separation_runtime(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    cuda: bool,
) -> Result<String, String> {
    separation::install(core.inner().clone(), app, cuda)
}
#[tauri::command]
fn separate_audio(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    device: String,
) -> Result<String, String> {
    ensure_idle(&core)?;
    if core.jobs.lock().map_err(io_error)?.values().any(|job| {
        job.saved.record.kind == "separation"
            && ["running", "queued"].contains(&job.saved.record.status.as_str())
    }) {
        return Err("BUSY".into());
    }
    separation::enqueue(core.inner().clone(), app, device)
}
#[tauri::command]
fn audio_paths(
    core: State<'_, Shared>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let session = core.session.lock().map_err(io_error)?;
    let s = session.as_ref().ok_or("NO_PROJECT")?;
    s.project
        .tracks
        .iter()
        .filter(|track| {
            track.kind == "audio"
                && track.source_path.as_ref().is_none_or(|path| {
                    s.project
                        .media
                        .as_ref()
                        .is_some_and(|media| path == &media.path)
                })
        })
        .map(|track| {
            Ok((
                track.id.clone(),
                project::asset(&s.root, track.path.as_deref().ok_or("INVALID_PATH")?)?
                    .to_string_lossy()
                    .into_owned(),
            ))
        })
        .collect()
}
#[tauri::command]
async fn export_audio_track(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    id: String,
    path: String,
    edited: Option<bool>,
) -> Result<Option<String>, String> {
    if edited.unwrap_or(false) {
        return audio_edit::enqueue(core.inner().clone(), app, &id, PathBuf::from(path)).map(Some);
    }
    let (input, root) = {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        let track = s
            .project
            .tracks
            .iter()
            .find(|track| track.id == id && track.kind == "audio")
            .ok_or("INVALID_PROJECT")?;
        (
            project::asset(&s.root, track.path.as_deref().ok_or("INVALID_PATH")?)?,
            s.root.clone(),
        )
    };
    let output = PathBuf::from(path);
    let parent = output
        .parent()
        .ok_or("INVALID_PATH")?
        .canonicalize()
        .map_err(io_error)?;
    if parent.starts_with(&root) && !parent.starts_with(root.join("exports")) {
        return Err("INVALID_PATH".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut input = std::fs::File::open(input).map_err(io_error)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(io_error)?;
        std::io::copy(&mut input, &mut temporary).map_err(io_error)?;
        temporary.as_file().sync_all().map_err(io_error)?;
        temporary.persist(output).map_err(io_error)?;
        Ok(None)
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
async fn export_report(
    core: State<'_, Shared>,
    path: String,
    content: String,
) -> Result<(), String> {
    if content.len() > 2_000_000 {
        return Err("INVALID_PROJECT".into());
    }
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|_| "INVALID_PROJECT".to_string())?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let output = PathBuf::from(path);
        let parent = output
            .parent()
            .ok_or("INVALID_PATH")?
            .canonicalize()
            .map_err(io_error)?;
        if let Some(s) = core.session.lock().map_err(io_error)?.as_ref() {
            if parent.starts_with(&s.root) && !parent.starts_with(s.root.join("exports")) {
                return Err("INVALID_PATH".into());
            }
        }
        project::atomic_write(&output, content.as_bytes())
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
fn list_jobs(core: State<'_, Shared>) -> Result<Vec<Job>, String> {
    Ok(core
        .jobs
        .lock()
        .map_err(io_error)?
        .values()
        .map(Control::snapshot)
        .collect())
}
#[tauri::command]
fn audio_effects_catalog() -> serde_json::Value {
    audio_effects::catalog().clone()
}
#[tauri::command]
fn apply_audio_effects(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    options: audio_fx_job::Options,
) -> Result<String, String> {
    audio_fx_job::enqueue(core.inner().clone(), app, options)
}
#[tauri::command]
fn cancel_job(core: State<'_, Shared>, id: String) -> Result<(), String> {
    let jobs = core.jobs.lock().map_err(io_error)?;
    let job = jobs.get(&id).ok_or("INVALID_PROJECT")?;
    job.cancel.store(true, Ordering::Relaxed);
    Ok(())
}
#[tauri::command]
fn pause_job(
    app: tauri::AppHandle,
    core: State<'_, Shared>,
    id: String,
    paused: bool,
) -> Result<(), String> {
    {
        let jobs = core.jobs.lock().map_err(io_error)?;
        let job = jobs.get(&id).ok_or("INVALID_PROJECT")?;
        if job.saved.record.kind != "separation"
            || !["running", "paused"].contains(&job.saved.record.status.as_str())
        {
            return Err("INVALID_PROJECT".into());
        }
        job.paused.store(paused, Ordering::Relaxed);
    }
    jobs::update(&core, &app, &id, |job| {
        job.status = if paused { "paused" } else { "running" }.into()
    });
    Ok(())
}
#[tauri::command]
fn retry_job(app: tauri::AppHandle, core: State<'_, Shared>, id: String) -> Result<String, String> {
    ensure_idle(&core)?;
    let record = core
        .jobs
        .lock()
        .map_err(io_error)?
        .get(&id)
        .ok_or("INVALID_PROJECT")?
        .saved
        .clone();
    if let Some(request) = record.audio_effects {
        let guard = core.session.lock().map_err(io_error)?;
        if guard.as_ref().is_none_or(|s| {
            s.root != request.root
                || s.project.id != request.project_id
                || s.project.revision != request.revision
        }) {
            return Err("STALE_REVISION".into());
        }
        drop(guard);
        return audio_fx_job::enqueue(core.inner().clone(), app, request.options);
    }
    if record.translation_install {
        return translation_llm::install(core.inner().clone(), app);
    }
    if let Some(request) = record.translation_request {
        let session = core.session.lock().map_err(io_error)?;
        if session
            .as_ref()
            .is_none_or(|s| s.project.id != request.basis.project_id)
        {
            return Err("STALE_REVISION".into());
        }
        drop(session);
        return translation_llm::enqueue(
            core.inner().clone(),
            app,
            request.basis.line_id,
            request.device,
            request.direction,
        );
    }
    if let Some(key) = record.tts_batch {
        return tts_batch::resume(core.inner().clone(), app, tts_batch::load(&core, &key)?);
    }
    if let Some(request) = record.face_detection {
        return face_detection::start(core.inner().clone(), app, request);
    }
    if let Some(key) = record.inpaint_batch {
        return inpaint_batch::resume(core.inner().clone(), app, inpaint_batch::load(&core, &key)?);
    }
    if record.inpaint_install {
        return inpaint::install_model(
            core.inner().clone(),
            app,
            record.inpaint_model.as_deref().unwrap_or(inpaint::MUSE),
        );
    }
    if let Some(request) = record.voice_conversion {
        return voice_capture::enqueue(core.inner().clone(), app, request);
    }
    if let Some(request) = record.prosody {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        if s.root != request.root
            || s.project.id != request.project_id
            || s.project.revision != request.revision
        {
            return Err("STALE_REVISION".into());
        }
        drop(session);
        return prosody::enqueue(core.inner().clone(), app, request);
    }
    if let Some(request) = record.audio_transfer {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        if s.root != request.root
            || s.project.id != request.project_id
            || s.project.revision != request.revision
        {
            return Err("STALE_REVISION".into());
        }
        drop(session);
        return audio_patch::enqueue(core.inner().clone(), app, request.options);
    }
    if let Some(request) = record.inpaint {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        if s.root != request.root || s.project.id != request.project_id {
            return Err("INPAINT_STALE".into());
        }
        drop(session);
        return inpaint::enqueue(core.inner().clone(), app, request.options);
    }
    if record.speaker_install {
        return speakers::install(core.inner().clone(), app);
    }
    if let Some(request) = record.mix_request {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        if s.root != request.root
            || s.project.id != request.project_id
            || s.project.revision != request.revision
        {
            return Err("STALE_REVISION".into());
        }
        drop(session);
        return mix::enqueue(core.inner().clone(), app, request.output, request.options);
    }
    if let Some(request) = record.source_transcription {
        return source_transcription::resume(core.inner().clone(), app, request);
    }
    if let Some(request) = record.toolbox_request {
        return audio_toolbox::enqueue(core.inner().clone(), app, request);
    }
    if let Some(id) = record.toolbox_install {
        return audio_toolbox::install(core.inner().clone(), app, id);
    }
    if let Some(request) = record.dubbing_pipeline {
        return dubbing_pipeline::enqueue(core.inner().clone(), app, request);
    }
    if let Some(request) = record.transcription {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        if s.root != request.root
            || s.project.id != request.project_id
            || s.project
                .voice_reference(request.character_id.as_deref(), &request.reference_id)
                .is_none_or(|r| {
                    r.path != request.reference_path || r.transcript != request.original_transcript
                })
        {
            return Err("STALE_REVISION".into());
        }
        drop(session);
        return transcription::enqueue(
            core.inner().clone(),
            app,
            request.character_id,
            request.reference_id,
            request.language,
        );
    }
    if let Some(request) = record.lips {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        if s.root != request.root
            || s.project.id != request.project_id
            || s.project.revision != request.revision
        {
            return Err("STALE_REVISION".into());
        }
        drop(session);
        return lips::enqueue(core.inner().clone(), app, request.options);
    }
    if let Some(cuda) = record.tts_install {
        return tts::install(core.inner().clone(), app, cuda);
    }
    if let Some(id) = record.voice_install {
        return voice_engines::install(core.inner().clone(), app, id);
    }
    if let Some(request) = record.character_match {
        return character_match::resume(core.inner().clone(), app, request);
    }
    if let Some(request) = record.voice_library {
        return voice_library::resume(core.inner().clone(), app, request);
    }
    if let Some(request) = record.tts_request {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        if s.root != request.root
            || s.project.id != request.project_id
            || !tts::matches_request(&s.project, &request)
        {
            return Err("STALE_REVISION".into());
        }
        drop(session);
        return tts::enqueue(core.inner().clone(), app, request.line_id, request.options);
    }
    if let Some(request) = record.speaker_request {
        let session = core.session.lock().map_err(io_error)?;
        let s = session.as_ref().ok_or("NO_PROJECT")?;
        if s.root != request.root
            || s.project.id != request.project_id
            || s.project
                .media
                .as_ref()
                .is_none_or(|media| media.path != request.source_path)
        {
            return Err("STALE_REVISION".into());
        }
        drop(session);
        return speakers::enqueue_scope(
            core.inner().clone(),
            app,
            request.threshold,
            request.scope,
        );
    }
    if let Some(request) = record.local_separation {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        if s.root != request.root
            || s.project.id != request.project_id
            || s.project
                .media
                .as_ref()
                .is_none_or(|m| m.path != request.source_path)
        {
            return Err("STALE_REVISION".into());
        }
        drop(guard);
        return local_separation::enqueue(core.inner().clone(), app, request.options);
    }
    if let Some(cuda) = record.runtime_cuda {
        return separation::install(core.inner().clone(), app, cuda);
    }
    if let Some(request) = record.separation {
        {
            let session = core.session.lock().map_err(io_error)?;
            let s = session.as_ref().ok_or("NO_PROJECT")?;
            if s.project.id != request.project_id
                || s.root != request.root
                || s.project.media.as_ref().is_none_or(|media| {
                    media.path != request.source_path
                        || media.audio_stream_index != Some(request.audio_index)
                })
            {
                return Err("STALE_REVISION".into());
            }
        }
        return separation::enqueue(core.inner().clone(), app, request.device);
    }
    let request = core
        .jobs
        .lock()
        .map_err(io_error)?
        .get(&id)
        .and_then(|c| c.saved.request.clone())
        .ok_or("INVALID_PROJECT")?;
    let session = core.session.lock().map_err(io_error)?;
    let s = session.as_ref().ok_or("NO_PROJECT")?;
    if s.project.id != request.project_id || s.root != request.root {
        return Err("NO_PROJECT".into());
    }
    Ok(jobs::enqueue(core.inner().clone(), app, request))
}
#[tauri::command]
async fn load_demo(app: tauri::AppHandle, core: State<'_, Shared>) -> Result<Project, String> {
    let core = core.inner().clone();
    ensure_idle(&core)?;
    let root = core.data_dir.join("First light.dubproject");
    if root.exists() {
        let p = project::load(&root)?;
        return attach(&app, &core, root.canonicalize().map_err(io_error)?, p);
    }
    let root = project::create_root(&core.data_dir, "First light")?;
    let packaged = app
        .path()
        .resource_dir()
        .map_err(io_error)?
        .join("demo/demo.mp4");
    let source = if packaged.is_file() {
        packaged
    } else {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../public/demo.mp4")
    };
    tokio::fs::copy(source, root.join("media/demo.mp4"))
        .await
        .map_err(io_error)?;
    let info = media::probe(&app, &root.join("media/demo.mp4")).await?;
    let mut p = Project::new("First light · Demo".into(), "en".into(), "fr".into());
    p.media = Some(MediaAsset {
        id: domain::id(),
        path: "media/demo.mp4".into(),
        preview_path: None,
        audio_stream_index: Some(1),
        info,
    });
    p.source_cues = subtitles::parse_srt("1\n00:00:00,750 --> 00:00:03,250\nEvery story begins with a voice.\n\n2\n00:00:04,500 --> 00:00:07,000\nListen. Find the right rhythm.\n\n3\n00:00:08,250 --> 00:00:11,250\nMake room for another language.\n\n4\n00:00:12,500 --> 00:00:15,000\nNow, make it yours.")?;
    p.target_cues = subtitles::parse_srt("1\n00:00:00,750 --> 00:00:03,250\nChaque histoire commence par une voix.\n\n2\n00:00:04,500 --> 00:00:07,000\nÉcoutez. Trouvez le bon rythme.\n\n3\n00:00:08,250 --> 00:00:11,250\nFaites place à une autre langue.\n\n4\n00:00:12,500 --> 00:00:15,000\nÀ vous de lui donner vie.")?;
    p.dialogues = subtitles::align(&p.source_cues, &p.target_cues);
    project::save(&root, &p)?;
    attach(&app, &core, root, p)
}
pub fn run() {
    let args: Vec<_> = std::env::args_os().collect();
    let test_data = if args.get(1).is_some_and(|arg| arg == "--ui-test") {
        args.get(2).map(PathBuf::from)
    } else {
        None
    };
    let mut context = tauri::generate_context!();
    if let Some(test_folder) = &test_data {
        // WebView2 ignores fake-capture switches supplied through its env
        // variable. A dedicated explicit test flag applies them to this
        // isolated test window only; production microphone permissions stay
        // under Windows/WebView2 control.
        let microphone = if args
            .get(3)
            .is_some_and(|arg| arg == "--synthetic-microphone")
        {
            let wav = test_folder.join("synthetic-microphone.wav");
            if !wav.is_file() {
                eprintln!("MIC_TEST_AUDIO_MISSING");
                return;
            }
            Some(format!(" --use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=\"{}\"",wav.display()))
        } else {
            None
        };
        for window in &mut context.config_mut().app.windows {
            window.visible = false;
            if let Some(arguments) = &microphone {
                window
                    .additional_browser_args
                    .get_or_insert_with(String::new)
                    .push_str(arguments);
            }
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let data_dir = match &test_data {
                Some(path) => path.clone(),
                None => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&data_dir)?;
            let mut restored = HashMap::new();
            if let Ok(bytes) = std::fs::read(data_dir.join("jobs.json")) {
                if let Ok(records) = serde_json::from_slice::<Vec<PersistedJob>>(&bytes) {
                    for saved in records {
                        restored.insert(saved.record.id.clone(), Control::restore(saved));
                    }
                }
            }
            let core = Arc::new(Core {
                session: Mutex::new(None),
                jobs: Mutex::new(restored),
                gate: Arc::new(tokio::sync::Semaphore::new(1)),
                model_dir: Mutex::new(model_storage::load(&data_dir)?),
                data_dir: data_dir.clone(),
            });
            jobs::start_timing_checkpoints(core.clone());
            app.manage(core);
            let automation = mcp::Controller::new(app.handle().clone(), data_dir);
            automation.restore();
            app.manage(automation);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mcp_status,
            mcp_prepare_update,
            mcp_update_failed,
            mcp_set_enabled,
            mcp_ready,
            mcp_claim,
            mcp_live,
            mcp_complete,
            translation_status,
            install_translation_model,
            suggest_translation,
            translation_result,
            latest_translation,
            transcribe_dialogue_source,
            source_transcription_result,
            latest_source_transcription,
            apply_source_transcription,
            set_voice_output_gain,
            generate_dubbing_pipeline,
            audio_toolbox_status,
            install_audio_toolbox_model,
            separate_audio_selection,
            audio_toolbox_result,
            audio_toolbox_path,
            apply_audio_toolbox_result,
            inpaint_status,
            install_inpaint,
            inpaint_lips,
            inpaint_path,
            preview_inpaint_batch,
            start_inpaint_batch,
            detect_inpaint_faces,
            face_detection_result,
            transfer_audio,
            audio_patch_path,
            analyze_lips,
            lip_analysis_result,
            latest_lip_analysis,
            tts_status,
            voice_status,
            voice_install_space,
            install_voice_runtime,
            install_tts_runtime,
            generate_line,
            prosody_status,
            mcp_store_microphone_take,
            convert_voice_timbre,
            transfer_voice_prosody,
            generation_path,
            dubbing_path,
            export_generation,
            model_storage_info,
            model_storage_size,
            change_model_storage,
            create_project,
            open_project,
            restore_project,
            replace_project,
            history,
            probe_media,
            import_media,
            prepare_proxy,
            import_subtitles,
            import_embedded_subtitles,
            media_path,
            get_waveform,
            export_subtitles,
            export_report,
            environment,
            graphics_info,
            set_graphics_preference,
            open_graphics_settings,
            separation_status,
            install_separation_runtime,
            separate_audio,
            audio_paths,
            export_audio_track,
            export_mkv,
            list_jobs,
            audio_effects_catalog,
            apply_audio_effects,
            cancel_job,
            pause_job,
            retry_job,
            speaker_status,
            install_speaker_runtime,
            identify_speakers,
            character_asset_path,
            capture_character_portrait,
            prepare_character_reference,
            prepare_voice_library_source,
            suggest_dialogue_character,
            character_suggestion_result,
            accept_character_suggestion,
            generate_voice_library,
            review_voice_library_sample,
            voice_library_audio_path,
            preview_character_sample,
            separate_audio_region,
            local_separation_result,
            local_separation_path,
            apply_local_separation,
            import_voice_reference,
            import_dubbing_reference,
            reference_audio_info,
            preview_dubbing_batch,
            generate_dubbing_batch,
            voice_reference_path,
            transcribe_voice_reference,
            load_demo
        ])
        .run(context)
        .expect("Unable to start desktop application");
}
