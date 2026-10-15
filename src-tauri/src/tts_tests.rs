use super::*;
use crate::domain::{Character, Cue, VoiceReference};
use std::{collections::HashMap, sync::Mutex};

fn options() -> Options {
    Options {
        variant_id: None,
        device: "cpu".into(),
        reference_mode: "character".into(),
        reference_id: None,
        mode: "crossLingual".into(),
        speed: 1.0,
        seed: 7,
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
    std::fs::write(&script,r#"import json,sys,wave,struct,time
r=json.load(open(sys.argv[-1],encoding='utf-8'))
open(r['preparedReferenceAudio'],'wb').write(b'normalized reference fixture')
if r['seed']==99:
    open(r['outputPath'],'wb').write(b'partial')
    print(json.dumps({'stage':'ttsGenerate','progress':None}),flush=True)
    time.sleep(10)
with wave.open(r['outputPath'],'wb') as out:
    out.setparams((1,2,24000,0,'NONE','not compressed'));out.writeframes(struct.pack('<h',1000)*28800)
json.dump({'device':'cpu','deviceName':'Protocol test','peakVramMb':0},open(r['resultPath'],'w'))
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
}
