use super::*;
use crate::domain::{Character, Cue, VoiceReference};
use crate::media;
use std::{collections::HashMap, sync::Mutex};

fn options() -> Options {
    Options {
        quality: None,
        mood: None,
        accent: None,
        variant_id: None,
        device: "cpu".into(),
        reference_track_id: None,
        reference_mode: "character".into(),
        reference_id: None,
        mode: "crossLingual".into(),
        speed: 1.0,
        seed: 7,
    }
}
#[test]
fn quality_settings_require_format19_and_preserve_legacy_defaults() {
    let mut value = options();
    assert_eq!(value.required_format(), 5);
    value.variant_id = Some("voxcpm2-bf16".into());
    value.quality = Some(serde_json::json!({"inferenceSteps":20,"cfgStrength":1.6}));
    value.validate().unwrap();
    assert_eq!(value.required_format(), 19);
    let saved = serde_json::to_value(&value).unwrap();
    let reopened: Options = serde_json::from_value(saved).unwrap();
    assert_eq!(reopened.quality, value.quality);
    value.quality = Some(serde_json::json!({"inferenceSteps":1000}));
    assert!(value.validate().is_err());
}
#[test]
fn multilingual_profiles_survive_disk_reload_and_choose_their_isolated_worker() {
    let temporary = tempfile::tempdir().unwrap();
    let core = Core {
        session: Mutex::new(None),
        jobs: Mutex::new(HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
        data_dir: temporary.path().into(),
        model_dir: Mutex::new(temporary.path().into()),
    };
    let app = tauri::test::mock_app();
    for (variant, provider) in [
        ("voxcpm2-bf16", "voxcpm2"),
        ("chatterbox-multilingual-v3", "chatterbox"),
    ] {
        let mut p = fixture();
        let mut o = options();
        o.variant_id = Some(variant.into());
        o.validate().unwrap();
        assert_eq!(o.required_format(), 16);
        p.format_version = 16;
        p.model_preferences =
            Some(serde_json::json!({"ttsProviderId":provider,"voiceVariantId":variant}));
        p.dialogues[0].voice_settings = Some(o.clone());
        let root = project::create_root(temporary.path(), variant).unwrap();
        project::save(&root, &p).unwrap();
        let loaded = project::load(&root).unwrap();
        assert_eq!(
            loaded.dialogues[0]
                .voice_settings
                .as_ref()
                .unwrap()
                .variant(),
            variant
        );
        assert_eq!(loaded.target_cues[0].text, "Bonjour");
        p.format_version = 15;
        assert!(p.validate().is_err());
        let request = Request {
            root,
            project_id: p.id.clone(),
            line_id: p.dialogues[0].id.clone(),
            options: o.clone(),
            fingerprint: String::new(),
            option_fingerprint: None,
            batch_item_id: None,
        };
        let launch = worker_launch(&core, app.handle(), &request);
        assert!(launch.script.ends_with("multilingual_worker.py"));
        assert!(launch.model.ends_with(variant));
        assert!(launch
            .python
            .starts_with(crate::voice_engines::root(&core).join("multilingual-runtime")));
        o.mood = Some("stressed".into());
        assert_eq!(o.validate().is_ok(), provider == "voxcpm2");
    }
}
#[test]
fn accents_route_to_style_prompts_without_modifying_subtitles_and_reject_qwen() {
    let mut p = fixture();
    p.characters[0].references[0].transcript = "Bonjour".into();
    let mut o = options();
    o.accent = Some("fr-FR".into());
    o.mood = Some("happy".into());
    for variant in [
        "cosy3-official",
        "fish-s2-fp8",
        "fish-s2-gguf-q8",
        "drama3-comfy-fp8",
    ] {
        o.variant_id = Some(variant.into());
        o.mode = if variant == "cosy3-official" {
            "crossLingual"
        } else {
            "zeroShot"
        }
        .into();
        assert!(validate_input(&p, &p.dialogues[0].id, &o).is_ok());
    }
    let spoken = text(&p, &p.dialogues[0]);
    let prompt = crate::voice_accent::fish_prompt(&spoken, &o);
    assert!(prompt.starts_with(
        "[speaking French with a native Metropolitan French accent from France] [happy] "
    ));
    assert!(prompt.ends_with(&spoken));
    assert_eq!(p.target_cues[0].text, "Bonjour");
    assert!(crate::voice_accent::validate(&o, Some("ja")).is_err());
    o.variant_id = Some("qwen3-06b-gguf-q8".into());
    assert_eq!(o.validate().unwrap_err(), "TTS_ACCENT_UNSUPPORTED");
    o.accent = Some("unknown".into());
    assert!(o.validate().is_err());
}

#[test]
fn standalone_reference_is_independent_of_characters_and_invalidates_inflight_snapshot() {
    let mut p = fixture();
    p.format_version = 9;
    let mut reference = p.characters[0].references[0].clone();
    reference.transcript = "日本語".into();
    p.voice_references.push(reference);
    p.characters.clear();
    p.dialogues[0].character_id = None;
    let mut o = options();
    o.reference_mode = "file".into();
    o.reference_id = Some("ref".into());
    o.mode = "zeroShot".into();
    p.dialogues[0].voice_settings = Some(o.clone());
    p.validate().unwrap();
    validate_input(&p, &p.dialogues[0].id, &o).unwrap();
    let before = fingerprint(&p, &p.dialogues[0].id).unwrap();
    p.voice_references[0].transcript = "Correction".into();
    assert_ne!(before, fingerprint(&p, &p.dialogues[0].id).unwrap());
    p.format_version = 8;
    assert!(p.validate().is_err());
    p.format_version = 9;
    p.voice_references[0].path = "../outside.wav".into();
    assert!(p.validate().is_err());
}

#[tokio::test]
async fn imported_mp3_is_copied_normalized_capped_and_undoable_without_a_character() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let mut p = fixture();
    p.characters.clear();
    p.dialogues[0].character_id = None;
    let line_id = p.dialogues[0].id.clone();
    let core = Arc::new(Core {
        session: Mutex::new(Some(project::Session::new(root.clone(), p))),
        jobs: Mutex::new(HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
        data_dir: root.clone(),
        model_dir: Mutex::new(root.clone()),
    });
    let app = tauri::test::mock_app();
    let mp3 = root.join("voix française.mp3");
    let result = media::command(&media::binary(app.handle(), "ffmpeg").unwrap())
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=400:sample_rate=44100",
            "-t",
            "21",
            "-ac",
            "2",
            "-n",
        ])
        .arg(&mp3)
        .output()
        .await
        .unwrap();
    assert!(result.status.success());
    let import = |path: PathBuf| {
        crate::speakers::reference(
            core.clone(),
            app.handle().clone(),
            crate::speakers::ReferenceTarget::Dialogue {
                line_id: Some(line_id.clone()),
                options: Box::new(options()),
            },
            None,
            Some(path.to_string_lossy().into_owned().into()),
            "French reference".into(),
        )
    };
    let saved = import(mp3.clone()).await.unwrap();
    assert!(saved.characters.is_empty());
    assert_eq!(saved.voice_references.len(), 1);
    let reference = &saved.voice_references[0];
    assert_eq!(reference.duration_ms, 20000);
    assert_eq!(saved.format_version, 9);
    let owned = project::asset(&root, &reference.path).unwrap();
    std::fs::remove_file(mp3).unwrap();
    assert_eq!(
        crate::audio_files::reference_duration(&owned).unwrap(),
        20000
    );
    let reopened = project::load(&root).unwrap();
    assert_eq!(
        reopened.dialogues[0]
            .voice_settings
            .as_ref()
            .unwrap()
            .reference_id
            .as_deref(),
        Some(reference.id.as_str())
    );
    let invalid = root.join("broken.wav");
    std::fs::write(&invalid, b"invalid").unwrap();
    assert!(import(invalid).await.is_err());
    let mut session = core.session.lock().unwrap();
    let s = session.as_mut().unwrap();
    assert_eq!(s.project.revision, saved.revision);
    assert!(s.history(false).unwrap().voice_references.is_empty());
    assert_eq!(
        s.history(true).unwrap().voice_references[0].id,
        reference.id
    );
}
#[test]
fn expanded_moods_roundtrip_with_format_15_without_touching_existing_takes() {
    let catalog: serde_json::Value =
        serde_json::from_str(include_str!("../../workers/voice-moods.json")).unwrap();
    assert_eq!(catalog["moods"].as_object().unwrap().len(), 43);
    for (id, spec) in catalog["moods"].as_object().unwrap() {
        let mut o = options();
        o.mood = Some(id.clone());
        let format = o.required_format();
        assert_eq!(format as u64, spec["minProjectVersion"].as_u64().unwrap());
        for variant in [
            "cosy3-official",
            "fish-s2-fp8",
            "fish-s2-gguf-q8",
            "drama3-comfy-fp8",
        ] {
            o.variant_id = Some(variant.into());
            o.validate().unwrap();
        }
        let mut p = fixture();
        p.format_version = format;
        p.dialogues[0].voice_settings = Some(o.clone());
        let next: Project = serde_json::from_slice(&serde_json::to_vec(&p).unwrap()).unwrap();
        next.validate().unwrap();
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        project::save(&root, &next).unwrap();
        let reopened = project::load(&root).unwrap();
        assert_eq!(reopened.format_version, format);
        assert_eq!(
            reopened.dialogues[0]
                .voice_settings
                .as_ref()
                .unwrap()
                .mood
                .as_deref(),
            Some(id.as_str())
        );
        assert!(next.generations.is_empty());
        assert_eq!(next.target_cues[0].text, "Bonjour");
        if format == 15 {
            p.format_version = 14;
            assert!(p.validate().is_err());
        }
        o.variant_id = Some("qwen3-06b-gguf-q8".into());
        assert_eq!(o.validate().is_ok(), id == "default");
        if id != "default" {
            o.accent = Some("fr-FR".into());
            let prompt = crate::voice_accent::fish_prompt("Bonjour !", &o);
            assert!(prompt.contains(&format!("[{}]", spec["fishInstruction"].as_str().unwrap())));
            assert!(prompt.starts_with("[speaking French"));
            assert!(prompt.ends_with(" Bonjour !"));
        }
    }
    let mut o = options();
    o.mood = Some("unknown".into());
    assert_eq!(o.validate().unwrap_err(), "TTS_STYLE_UNSUPPORTED");
}
#[test]
fn mood_presets_are_supported_for_cosy_and_fish_but_not_qwen_base() {
    let mut value = options();
    value.mood = Some("angry".into());
    assert!(value.validate().is_ok());
    value.variant_id = Some("fish-s2-fp8".into());
    assert!(value.validate().is_ok());
    value.variant_id = Some("qwen3-06b-gguf-q8".into());
    assert_eq!(value.validate().unwrap_err(), "TTS_STYLE_UNSUPPORTED");
    value.mood = Some("default".into());
    assert!(value.validate().is_ok());
}

#[tokio::test]
async fn worker_logs_keep_pipes_open_after_invalid_native_bytes_and_preserve_unicode() {
    let temporary = tempfile::tempdir().unwrap();
    let core = Arc::new(Core {
        session: Mutex::new(None),
        jobs: Mutex::new(HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
        data_dir: temporary.path().into(),
        model_dir: Mutex::new(temporary.path().into()),
    });
    let app = tauri::test::mock_app();
    let script = temporary.path().join("unicode.py");
    std::fs::write(&script, r#"import sys,json,time
print(json.dumps({'stage':'ttsGenerate','progress':None}),flush=True)
if sys.argv[-1]=='legacy':
    sys.stderr.buffer.write(b'native warning: \xe9\xff\n');sys.stderr.buffer.flush()
    time.sleep(0.15)
else:
    assert sys.stdout.encoding.lower().replace('-','')=='utf8'
    assert sys.stderr.encoding.lower().replace('-','')=='utf8'
print('synthesis text Il \u00e9tait une fois un assassin l\u00e9gendaire. \u65e5\u672c\u8a9e',file=sys.stderr,flush=True)
print('log after invalid bytes',file=sys.stderr,flush=True)
print(json.dumps({'stage':'done','progress':1}),flush=True)
"#).unwrap();
    for mode in ["legacy", "unicode"] {
        let key = jobs::create(&core, app.handle(), "tts", "test".into(), None);
        separation::process(
            &core,
            app.handle(),
            &key,
            &PathBuf::from(if cfg!(windows) { "python" } else { "python3" }),
            &[script.to_string_lossy().into_owned(), mode.into()],
            &AtomicBool::new(false),
        )
        .await
        .unwrap();
        let jobs = core.jobs.lock().unwrap();
        let job = &jobs.get(&key).unwrap().saved.record;
        assert_eq!(job.stage, "done");
        assert!(job
            .logs
            .iter()
            .any(|l| l.contains("log after invalid bytes")));
        assert!(job
            .logs
            .iter()
            .any(|l| l.contains("Il était une fois un assassin légendaire. 日本語")));
    }
}

#[tokio::test]
async fn engine_exit_keeps_last_stage_stderr_exit_status_and_protocol_error() {
    let temporary = tempfile::tempdir().unwrap();
    let core = Arc::new(Core {
        session: Mutex::new(None),
        jobs: Mutex::new(HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
        data_dir: temporary.path().into(),
        model_dir: Mutex::new(temporary.path().into()),
    });
    let app = tauri::test::mock_app();
    let script = temporary.path().join("crash.py");
    std::fs::write(&script, r#"import json,sys,os
print(json.dumps({'stage':'ttsReferenceTokens','progress':None,'log':'Reference tokenization on CPU'}),flush=True)
print('A warning is not a fatal error',file=sys.stderr,flush=True)
if sys.argv[-1]=='protocol':
    print(json.dumps({'error':'TTS_OUT_OF_MEMORY'}),flush=True)
    sys.exit(1)
if os.name=='nt':
    import ctypes
    ctypes.windll.kernel32.ExitProcess(0xC0000005)
os._exit(23)
"#).unwrap();
    let executable = PathBuf::from(if cfg!(windows) { "python" } else { "python3" });
    for mode in ["native", "protocol"] {
        let key = jobs::create(&core, app.handle(), "tts", "test".into(), None);
        let result = separation::process(
            &core,
            app.handle(),
            &key,
            &executable,
            &[script.to_string_lossy().into_owned(), mode.into()],
            &AtomicBool::new(false),
        )
        .await;
        let expected = if mode == "protocol" {
            "TTS_OUT_OF_MEMORY"
        } else if cfg!(windows) {
            "TTS_NATIVE_CRASH"
        } else {
            "TTS_ENGINE_FAILED"
        };
        assert_eq!(result.unwrap_err(), expected);
        let jobs = core.jobs.lock().unwrap();
        let job = &jobs.get(&key).unwrap().saved.record;
        assert_eq!(job.stage, "ttsReferenceTokens");
        assert!(job.logs.iter().any(|l| l.contains("warning")));
        assert!(job
            .logs
            .iter()
            .any(|l| l.contains("Reference tokenization on CPU")));
        assert!(job.logs.last().unwrap().contains("exit code"));
        assert!(job.logs.last().unwrap().contains("ttsReferenceTokens"));
        if mode == "native" && cfg!(windows) {
            assert!(job.logs.last().unwrap().contains("0xC0000005"));
        }
    }
}
#[test]
fn dependency_extraction_copy_observes_cancellation_between_chunks() {
    struct Source<'a> {
        flag: &'a AtomicBool,
    }
    impl std::io::Read for Source<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            buffer[..100].fill(7);
            self.flag.store(true, Ordering::Relaxed);
            Ok(100)
        }
    }
    let flag = AtomicBool::new(false);
    let mut source = Source { flag: &flag };
    let mut output = Vec::new();
    assert_eq!(
        copy_cancelled(&mut source, &mut output, &flag).unwrap_err(),
        "CANCELLED"
    );
    assert_eq!(output.len(), 100);
}
fn fixture() -> Project {
    let mut p = Project::new("Dubbing".into(), "ja".into(), "fr".into());
    p.format_version = 3;
    p.target_cues.push(Cue {
        id: "target".into(),
        start_ms: 1000,
        end_ms: 2500,
        text: "Bonjour".into(),
    });
    p.dialogues = crate::subtitles::align(&[], &p.target_cues);
    p.dialogues[0].character_id = Some("speaker".into());
    p.characters.push(Character {
        id: "speaker".into(),
        name: "Speaker".into(),
        color: "#aa44cc".into(),
        references: vec![VoiceReference {
            id: "ref".into(),
            label: "Neutral".into(),
            path: "characters/ref.wav".into(),
            duration_ms: 1200,
            transcript: String::new(),
            source_dialogue_id: None,
        }],
        default_reference_id: Some("ref".into()),
    });
    p
}
fn wave(path: &Path) {
    let data = vec![0_u8; 24000 * 2 * 12 / 10];
    let mut bytes = Vec::new();
    bytes.extend(b"RIFF");
    bytes.extend((36 + data.len() as u32).to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(16_u32.to_le_bytes());
    bytes.extend(1_u16.to_le_bytes());
    bytes.extend(1_u16.to_le_bytes());
    bytes.extend(24000_u32.to_le_bytes());
    bytes.extend(48000_u32.to_le_bytes());
    bytes.extend(2_u16.to_le_bytes());
    bytes.extend(16_u16.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend((data.len() as u32).to_le_bytes());
    bytes.extend(data);
    std::fs::write(path, bytes).unwrap();
}

#[test]
fn tts_snapshot_and_reference_validation() {
    let mut p = fixture();
    let line_id = p.dialogues[0].id.clone();
    let original = fingerprint(&p, &line_id).unwrap();
    assert!(validate_input(&p, &line_id, &options()).is_ok());
    let mut settings = options();
    settings.mode = "zeroShot".into();
    assert_eq!(
        validate_input(&p, &line_id, &settings).unwrap_err(),
        "TTS_TRANSCRIPT_REQUIRED"
    );
    p.characters[0].references[0].transcript = "Hello".into();
    assert_ne!(fingerprint(&p, &line_id).unwrap(), original);
    assert!(validate_input(&p, &line_id, &settings).is_ok());
    p.dialogues[0].tts_text = Some("<i>Sakamoto</i>".into());
    p.pronunciation
        .insert("Sakamoto".into(), "Sakamotto".into());
    assert_eq!(text(&p, &p.dialogues[0]), "Sakamotto");
    settings.device = "cuda:-1".into();
    assert!(settings.validate().is_err());
    settings = options();
    settings.speed = f64::NAN;
    assert!(settings.validate().is_err());
    p.languages.target = "xx".into();
    assert_eq!(
        validate_input(&p, &line_id, &options()).unwrap_err(),
        "TTS_LANGUAGE_UNSUPPORTED"
    );
}

#[tokio::test]
async fn reference_range_copies_the_requested_audio_after_twenty_seconds_and_rejects_invalid_spans()
{
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let p = fixture();
    let core = Arc::new(Core {
        session: Mutex::new(Some(project::Session::new(root.clone(), p))),
        jobs: Mutex::new(HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
        data_dir: root.clone(),
        model_dir: Mutex::new(root.clone()),
    });
    let input = root.join("long reference é.wav");
    let mut pcm = Vec::with_capacity(24 * 24000 * 2);
    for i in 0..24 * 24000 {
        pcm.extend((if i < 20 * 24000 { 1000i16 } else { 5000i16 }).to_le_bytes());
    }
    let mut bytes = b"RIFF".to_vec();
    bytes.extend((36 + pcm.len() as u32).to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(16u32.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(24000u32.to_le_bytes());
    bytes.extend(48000u32.to_le_bytes());
    bytes.extend(2u16.to_le_bytes());
    bytes.extend(16u16.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend((pcm.len() as u32).to_le_bytes());
    bytes.extend(pcm);
    std::fs::write(&input, bytes).unwrap();
    let app = tauri::test::mock_app();
    let file = |start, end| crate::speakers::ReferenceFile {
        path: input.to_string_lossy().into_owned(),
        range: Some(crate::speakers::ReferenceSpan {
            start_ms: start,
            end_ms: end,
        }),
    };
    let saved = crate::speakers::reference(
        core.clone(),
        app.handle().clone(),
        crate::speakers::ReferenceTarget::Dialogue {
            line_id: None,
            options: Box::new(options()),
        },
        None,
        Some(file(21000, 23000)),
        "Excerpt".into(),
    )
    .await
    .unwrap();
    assert_eq!(saved.voice_references[0].duration_ms, 2000);
    assert!(saved.dialogues[0].voice_settings.is_none());
    let bytes = std::fs::read(root.join(&saved.voice_references[0].path)).unwrap();
    let data = bytes.windows(4).position(|b| b == b"data").unwrap() + 8;
    assert!(bytes[data..]
        .as_chunks::<2>()
        .0
        .iter()
        .all(|b| i16::from_le_bytes([b[0], b[1]]) == 5000));
    let saved = crate::speakers::reference(
        core.clone(),
        app.handle().clone(),
        crate::speakers::ReferenceTarget::Character("speaker".into()),
        None,
        Some(file(21000, 23000)),
        "Character excerpt".into(),
    )
    .await
    .unwrap();
    assert_eq!(
        saved.characters[0].references.last().unwrap().duration_ms,
        2000
    );
    for (start, end) in [
        (0, 21000),
        (22000, 25000),
        (22000, 22000),
        (21000, 21500),
        (u64::MAX, 1),
    ] {
        assert_eq!(
            crate::speakers::reference(
                core.clone(),
                app.handle().clone(),
                crate::speakers::ReferenceTarget::Character("speaker".into()),
                None,
                Some(file(start, end)),
                "Invalid".into()
            )
            .await
            .unwrap_err(),
            "INVALID_REFERENCE_RANGE"
        );
    }
    assert_eq!(
        core.session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .project
            .revision,
        saved.revision
    );
}

#[test]
fn phase6_variants_survive_project_validation_and_fish_requires_transcript_mode() {
    let mut p = fixture();
    p.format_version = 5;
    let mut settings = options();
    for (id, provider) in [
        ("qwen3-06b-gguf-q8", "qwen3-tts"),
        ("qwen3-17b-gguf-q8", "qwen3-tts"),
        ("fish-s2-gguf-q8", "fish-s2"),
        ("fish-s2-fp8", "fish-s2"),
        ("drama3-comfy-fp8", "fish-drama3"),
    ] {
        settings.variant_id = Some(id.into());
        settings.device = if id.contains("gguf") {
            "vulkan:1"
        } else {
            "cuda:0"
        }
        .into();
        settings.mode = "zeroShot".into();
        p.characters[0].references[0].transcript = "Hello".into();
        p.dialogues[0].voice_settings = Some(settings.clone());
        p.model_preferences =
            Some(serde_json::json!({"ttsProviderId":provider,"voiceVariantId":id}));
        assert!(settings.validate().is_ok());
        assert!(p.validate().is_ok());
        assert!(validate_input(&p, &p.dialogues[0].id, &settings).is_ok());
    }
    settings.mode = "crossLingual".into();
    assert_eq!(
        validate_input(&p, &p.dialogues[0].id, &settings).unwrap_err(),
        "TTS_TRANSCRIPT_REQUIRED"
    );
    settings.variant_id = Some("unknown-engine".into());
    assert!(settings.validate().is_err());
}

#[tokio::test]
async fn tts_refuses_missing_runtime_without_job_or_project_changes() {
    let temp = tempfile::tempdir().unwrap();
    let root = project::create_root(temp.path(), "Runtime check").unwrap();
    let p = fixture();
    project::save(&root, &p).unwrap();
    let line_id = p.dialogues[0].id.clone();
    let core = Arc::new(Core {
        session: Mutex::new(Some(project::Session::new(root.clone(), p))),
        jobs: Mutex::new(HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
        data_dir: temp.path().to_path_buf(),
        model_dir: Mutex::new(temp.path().to_path_buf()),
    });
    let app = tauri::test::mock_app();
    assert_eq!(
        enqueue(core.clone(), app.handle().clone(), line_id, options()).unwrap_err(),
        "TTS_RUNTIME_REQUIRED"
    );
    assert!(core.jobs.lock().unwrap().is_empty());
    assert_eq!(project::load(&root).unwrap().format_version, 3);
}

#[tokio::test]
async fn generation_job_keeps_takes_and_cancellation_preserves_previous_audio() {
    let temp = tempfile::tempdir().unwrap();
    let root = project::create_root(temp.path(), "Generated takes").unwrap();
    let p = fixture();
    project::save(&root, &p).unwrap();
    wave(&root.join("characters/ref.wav"));
    let core = Arc::new(Core {
        session: Mutex::new(Some(project::Session::new(root.clone(), p.clone()))),
        jobs: Mutex::new(HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
        data_dir: temp.path().to_path_buf(),
        model_dir: Mutex::new(temp.path().to_path_buf()),
    });
    let app = tauri::test::mock_app();
    let script = temp.path().join("worker.py");
    std::fs::write(&script,r#"import json,sys,wave,struct,time,os
r=json.load(open(sys.argv[-1],encoding='utf-8'))
open(r['preparedReferenceAudio'],'wb').write(b'normalized reference fixture')
if r['seed']==88 and not r.get('compatibilityMode'):
    open(r['outputPath'],'wb').write(b'partial from failed CUDA attempt')
    print(json.dumps({'stage':'ttsReferenceTokens','progress':None}),flush=True)
    os._exit(23)
if r['seed']==88:
    assert r['device']=='cuda:0' and r['compatibilityMode'] is True
if r['seed']==99:
    open(r['outputPath'],'wb').write(b'partial')
    print(json.dumps({'stage':'ttsGenerate','progress':None}),flush=True)
    time.sleep(10)
with wave.open(r['outputPath'],'wb') as out:
    out.setparams((1,2,24000,0,'NONE','not compressed'));out.writeframes(struct.pack('<h',1000)*28800)
json.dump({'device':r['device'],'deviceName':'Protocol test','peakVramMb':0,'compatibilityMode':r.get('compatibilityMode',False)},open(r['resultPath'],'w'))
"#).unwrap();
    let launch = WorkerLaunch {
        python: PathBuf::from(if cfg!(windows) { "python" } else { "python3" }),
        script,
        model: temp.path().join("unused-model"),
    };
    let request = Request {
        root: root.clone(),
        project_id: p.id.clone(),
        line_id: p.dialogues[0].id.clone(),
        options: options(),
        fingerprint: fingerprint(&p, &p.dialogues[0].id).unwrap(),
        option_fingerprint: None,
        batch_item_id: None,
    };
    for _ in 0..2 {
        let key = jobs::create(&core, app.handle(), "tts", p.id.clone(), None);
        execute_with_launch(
            &core,
            app.handle(),
            &key,
            &request,
            &AtomicBool::new(false),
            &launch,
        )
        .await
        .unwrap();
    }
    let loaded = project::load(&root).unwrap();
    assert_eq!(loaded.format_version, 5);
    assert_eq!(loaded.generations.len(), 2);
    assert_ne!(loaded.generations[0]["path"], loaded.generations[1]["path"]);
    let first = project::asset(&root, loaded.generations[0]["path"].as_str().unwrap()).unwrap();
    let bytes = std::fs::read(&first).unwrap();
    assert_eq!(
        crate::audio_files::pcm_frames(&first, 1, 24000, "TTS_EMPTY_AUDIO").unwrap(),
        28800
    );
    let key = jobs::create(&core, app.handle(), "tts", p.id.clone(), None);
    let flag = Arc::new(AtomicBool::new(false));
    let cancel = flag.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        cancel.store(true, Ordering::Relaxed);
    });
    let mut cancelled = request.clone();
    cancelled.options.seed = 99;
    assert_eq!(
        execute_with_launch(&core, app.handle(), &key, &cancelled, &flag, &launch)
            .await
            .unwrap_err(),
        "CANCELLED"
    );
    assert_eq!(project::load(&root).unwrap().generations.len(), 2);
    assert_eq!(std::fs::read(first).unwrap(), bytes);
    assert!(!std::fs::read_dir(root.join("generations"))
        .unwrap()
        .any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with("-normalized.wav")));
    let mut invalid = loaded.clone();
    invalid.format_version = 4;
    assert_eq!(invalid.validate().unwrap_err(), "INVALID_GENERATION");
    invalid = loaded;
    invalid.generations[0]["path"] = "../outside.wav".into();
    assert_eq!(invalid.validate().unwrap_err(), "INVALID_PATH");
    let mut retry = request.clone();
    retry.options.seed = 88;
    retry.options.device = "cuda:0".into();
    let key = jobs::create(&core, app.handle(), "tts", p.id.clone(), None);
    execute_with_launch(
        &core,
        app.handle(),
        &key,
        &retry,
        &AtomicBool::new(false),
        &launch,
    )
    .await
    .unwrap();
    let recovered = project::load(&root).unwrap();
    assert_eq!(recovered.generations.len(), 3);
    assert_eq!(recovered.generations[2]["device"], "cuda:0");
    assert_eq!(recovered.generations[2]["compatibilityMode"], true);
    assert!(core
        .jobs
        .lock()
        .unwrap()
        .get(&key)
        .unwrap()
        .saved
        .record
        .logs
        .iter()
        .any(|l| l.contains("Retrying once")));
}
