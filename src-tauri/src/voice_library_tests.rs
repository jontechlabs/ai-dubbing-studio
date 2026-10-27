use super::*;
use crate::domain::{Character, Cue};
use std::{collections::HashMap, sync::Mutex};

fn options() -> tts::Options {
    serde_json::from_value(serde_json::json!({"variantId":"voxcpm2-bf16","device":"cpu","referenceMode":"character","referenceId":null,"mode":"crossLingual","mood":"default","accent":"fr-FR","speed":1,"seed":0})).unwrap()
}
fn wave(path: &Path, duration: u64) {
    let frames = duration * 24;
    let mut bytes = Vec::new();
    bytes.extend(b"RIFF");
    bytes.extend((36 + frames as u32 * 2).to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(16_u32.to_le_bytes());
    bytes.extend(1_u16.to_le_bytes());
    bytes.extend(1_u16.to_le_bytes());
    bytes.extend(24000_u32.to_le_bytes());
    bytes.extend(48000_u32.to_le_bytes());
    bytes.extend(2_u16.to_le_bytes());
    bytes.extend(16_u16.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend((frames as u32 * 2).to_le_bytes());
    for i in 0..frames {
        bytes.extend((if i % 2 == 0 { 1000_i16 } else { -1000_i16 }).to_le_bytes());
    }
    std::fs::write(path, bytes).unwrap();
}
fn fixture(root: &Path) -> Project {
    let mut p = Project::new("Bibliothèque 日本".into(), "ja".into(), "fr".into());
    p.format_version = 21;
    p.target_cues = vec![Cue {
        id: "target".into(),
        start_ms: 0,
        end_ms: 6000,
        text: "Bonjour à tous.".into(),
    }];
    p.dialogues = crate::subtitles::align(&[], &p.target_cues);
    p.dialogues[0].character_id = Some("owner".into());
    std::fs::create_dir_all(root.join("characters/voice-library")).unwrap();
    wave(&root.join("characters/original.wav"), 6000);
    let raw = VoiceReference {
        id: "raw".into(),
        label: "Original".into(),
        path: "characters/original.wav".into(),
        duration_ms: 6000,
        transcript: "日本語".into(),
        source_dialogue_id: None,
    };
    p.characters.push(Character {
        id: "owner".into(),
        name: "Personnage 01".into(),
        color: "#82bda0".into(),
        references: vec![raw],
        default_reference_id: Some("raw".into()),
    });
    wave(&root.join("characters/voice-library/source.wav"), 6000);
    let source = Source {
        id: "source".into(),
        reference: VoiceReference {
            id: "source".into(),
            label: "Deux extraits".into(),
            path: "characters/voice-library/source.wav".into(),
            duration_ms: 6000,
            transcript: String::new(),
            source_dialogue_id: None,
        },
        segments: vec![
            Segment {
                reference_id: Some("raw".into()),
                dialogue_id: None,
                track_id: None,
                start_ms: 0,
                end_ms: 3000,
            },
            Segment {
                reference_id: Some("raw".into()),
                dialogue_id: None,
                track_id: None,
                start_ms: 3000,
                end_ms: 6000,
            },
        ],
        sha256: digest(&root.join("characters/voice-library/source.wav")).unwrap(),
        created_at: now(),
    };
    library_mut(&mut p, "owner").unwrap().sources.push(source);
    p.generations.push(serde_json::json!({"kind":"tts","id":"old","dialogueId":p.dialogues[0].id,"providerId":"voxcpm2","modelId":"voxcpm2-bf16","language":"fr","text":"Bonjour à tous.","startMs":0,"endMs":6000,"characterId":"owner","sourcePath":null,"options":options(),"referenceId":"raw","referenceTranscript":"日本語","path":"generations/old.wav","durationMs":1200,"sampleRate":24000,"createdAt":now(),"device":"cpu","deviceName":"CPU","peakVramMb":0,"inputHash":"old"}));
    p.validate().unwrap();
    p
}
fn core(root: &Path, p: Project) -> Arc<Core> {
    Arc::new(Core {
        session: Mutex::new(Some(project::Session::new(root.into(), p))),
        jobs: Mutex::new(HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
        data_dir: root.into(),
        model_dir: Mutex::new(root.into()),
    })
}
fn request(root: &Path, p: &Project, texts: &[&str]) -> Request {
    Request {
        root: root.into(),
        project_id: p.id.clone(),
        source_hash: source_fingerprint(&library(p, "owner").unwrap().sources[0]).unwrap(),
        generation: Generation {
            character_id: "owner".into(),
            source_id: "source".into(),
            phrases: texts
                .iter()
                .map(|text| Phrase {
                    id: id(),
                    label: (*text).into(),
                    text: (*text).into(),
                    mood: "default".into(),
                })
                .collect(),
            options: options(),
        },
    }
}
fn worker(root: &Path) -> tts::WorkerLaunch {
    let script = root.join("protocol.py");
    std::fs::write(&script,r#"import json,sys,wave,struct,os,time
from pathlib import Path
for line in sys.stdin:
 c=json.loads(line);r=json.load(open(c['path'],encoding='utf-8-sig'));root=Path(r['outputPath']).parent.parent.parent
 with (root/'calls.jsonl').open('a') as f:f.write(json.dumps(dict(pid=os.getpid(),text=r['text']))+'\n')
 if r['text']=='slow':
  Path(r['outputPath']).write_bytes(b'partial');print(json.dumps(dict(stage='ttsGenerate')),flush=True);time.sleep(30)
 if r['text']=='fail' and not (root/'retry').exists():
  print(json.dumps(dict(requestDone=c['requestId'],error='TTS_EMPTY_AUDIO')),flush=True);break
 with wave.open(r['outputPath'],'wb') as out:
  out.setparams((1,2,24000,0,'NONE',''));out.writeframes(struct.pack('<h',1000)*28800)
 Path(r['resultPath']).write_text(json.dumps(dict(deviceName='Protocol test')))
 print(json.dumps(dict(requestDone=c['requestId'])),flush=True)
"#).unwrap();
    tts::WorkerLaunch {
        python: PathBuf::from(if cfg!(windows) { "python" } else { "python3" }),
        script,
        model: root.join("model"),
    }
}
#[tokio::test]
async fn library_hot_batch_review_default_reopen_undo_and_retry_preserve_all_takes() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let p = fixture(&root);
    project::save(&root, &p).unwrap();
    let req = request(&root, &p, &["Bonjour à tous.", "Merci beaucoup."]);
    let old = p.generations.clone();
    let lines = serde_json::to_value(&p.dialogues).unwrap();
    let core = core(&root, p);
    let app = tauri::test::mock_app();
    let launch = worker(&root);
    let key = jobs::create(
        &core,
        app.handle(),
        "voiceLibrary",
        req.project_id.clone(),
        None,
    );
    run(
        &core,
        app.handle(),
        &key,
        &req,
        &AtomicBool::new(false),
        &launch,
    )
    .await
    .unwrap();
    let rows = std::fs::read_to_string(root.join("calls.jsonl"))
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str::<serde_json::Value>(s).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["pid"], rows[1]["pid"]);
    let saved = project::load(&root).unwrap();
    assert_eq!(saved.generations, old);
    assert_eq!(serde_json::to_value(&saved.dialogues).unwrap(), lines);
    assert_eq!(library(&saved, "owner").unwrap().samples.len(), 2);
    assert!(reference(&saved, "owner", None).is_none());
    let sample = library(&saved, "owner").unwrap().samples[0].id.clone();
    {
        let mut session = core.session.lock().unwrap();
        let s = session.as_mut().unwrap();
        let approved = review(
            &s.project,
            &Review {
                character_id: "owner".into(),
                sample_id: sample.clone(),
                status: Some("approved".into()),
                transcript: None,
                use_default: true,
            },
        )
        .unwrap();
        s.replace(approved, s.project.revision).unwrap();
        assert_eq!(
            reference(&project::load(&root).unwrap(), "owner", None)
                .unwrap()
                .id,
            sample
        );
        let withdrawn = review(
            &s.project,
            &Review {
                character_id: "owner".into(),
                sample_id: sample.clone(),
                status: None,
                transcript: Some("Transcription corrigée.".into()),
                use_default: false,
            },
        )
        .unwrap();
        s.replace(withdrawn, s.project.revision).unwrap();
        assert!(reference(&s.project, "owner", None).is_none());
        s.history(false).unwrap();
        assert!(reference(&s.project, "owner", None).is_some());
        assert_eq!(s.project.generations, old);
    }
    run(
        &core,
        app.handle(),
        &key,
        &req,
        &AtomicBool::new(false),
        &launch,
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("calls.jsonl"))
            .unwrap()
            .lines()
            .count(),
        2
    );
    assert_eq!(
        library(&project::load(&root).unwrap(), "owner")
            .unwrap()
            .samples
            .len(),
        2
    );
}
#[tokio::test]
async fn library_partial_failure_retry_and_cancellation_keep_completed_samples_and_original_files()
{
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let p = fixture(&root);
    project::save(&root, &p).unwrap();
    let before = std::fs::read(root.join("characters/original.wav")).unwrap();
    let req = request(&root, &p, &["Une phrase.", "fail"]);
    let core = core(&root, p);
    let app = tauri::test::mock_app();
    let launch = worker(&root);
    let key = jobs::create(
        &core,
        app.handle(),
        "voiceLibrary",
        req.project_id.clone(),
        None,
    );
    assert!(run(
        &core,
        app.handle(),
        &key,
        &req,
        &AtomicBool::new(false),
        &launch
    )
    .await
    .is_err());
    assert_eq!(
        library(&project::load(&root).unwrap(), "owner")
            .unwrap()
            .samples
            .len(),
        1
    );
    std::fs::write(root.join("retry"), b"1").unwrap();
    run(
        &core,
        app.handle(),
        &key,
        &req,
        &AtomicBool::new(false),
        &launch,
    )
    .await
    .unwrap();
    assert_eq!(
        library(&project::load(&root).unwrap(), "owner")
            .unwrap()
            .samples
            .len(),
        2
    );
    let current = project::load(&root).unwrap();
    let slow = request(&root, &current, &["slow"]);
    let flag = AtomicBool::new(false);
    let cancel = async {
        while !std::fs::read_to_string(root.join("calls.jsonl"))
            .unwrap_or_default()
            .contains("slow")
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        flag.store(true, Ordering::Relaxed);
    };
    let (result, ()) = tokio::join!(
        run(&core, app.handle(), &key, &slow, &flag, &launch),
        cancel
    );
    assert_eq!(result.unwrap_err(), "CANCELLED");
    assert_eq!(
        std::fs::read(root.join("characters/original.wav")).unwrap(),
        before
    );
    assert_eq!(
        library(&project::load(&root).unwrap(), "owner")
            .unwrap()
            .samples
            .len(),
        2
    );
    assert!(!std::fs::read_dir(root.join("characters/voice-library"))
        .unwrap()
        .any(|p| std::fs::read(p.unwrap().path()).unwrap_or_default() == b"partial"));
}
#[tokio::test]
async fn real_source_concatenation_is_bounded_owned_undoable_and_immutable() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let p = fixture(&root);
    project::save(&root, &p).unwrap();
    let before = std::fs::read(root.join("characters/original.wav")).unwrap();
    let old = p.generations.clone();
    let core = core(&root, p);
    let app = tauri::test::mock_app();
    let options = SourceOptions {
        character_id: "owner".into(),
        label: "Deux portions".into(),
        segments: vec![
            Segment {
                reference_id: Some("raw".into()),
                dialogue_id: None,
                track_id: None,
                start_ms: 500,
                end_ms: 3000,
            },
            Segment {
                reference_id: Some("raw".into()),
                dialogue_id: None,
                track_id: None,
                start_ms: 3000,
                end_ms: 6000,
            },
        ],
    };
    let next = prepare(core.clone(), app.handle().clone(), options.clone())
        .await
        .unwrap();
    let source = library(&next, "owner").unwrap().sources.last().unwrap();
    assert!(source.reference.duration_ms.abs_diff(5500) <= 4);
    assert_eq!(
        digest(&root.join(&source.reference.path)).unwrap(),
        source.sha256
    );
    assert_eq!(next.generations, old);
    assert_eq!(
        std::fs::read(root.join("characters/original.wav")).unwrap(),
        before
    );
    core.session
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .history(false)
        .unwrap();
    assert_eq!(
        library(&project::load(&root).unwrap(), "owner")
            .unwrap()
            .sources
            .len(),
        1
    );
    assert!(root.join(&source.reference.path).is_file());
    for (start, end) in [(0, 4900), (0, 21000), (5000, 4000)] {
        let mut bad = options.clone();
        bad.segments = vec![Segment {
            reference_id: Some("raw".into()),
            dialogue_id: None,
            track_id: None,
            start_ms: start,
            end_ms: end,
        }];
        assert!(prepare(core.clone(), app.handle().clone(), bad)
            .await
            .is_err());
    }
    let mut bad = options;
    bad.character_id = "other".into();
    assert!(prepare(core.clone(), app.handle().clone(), bad)
        .await
        .is_err());
}
#[test]
fn invalid_library_profiles_fail_before_use_and_pending_samples_cannot_be_default() {
    let tmp = tempfile::tempdir().unwrap();
    let p = fixture(tmp.path());
    let mut bad = p.clone();
    bad.format_version = 20;
    assert!(bad.validate().is_err());
    let mut bad = p.clone();
    library_mut(&mut bad, "owner").unwrap().sources[0]
        .reference
        .path = "../outside.wav".into();
    assert!(bad.validate().is_err());
    let mut bad = p.clone();
    library_mut(&mut bad, "owner").unwrap().default_sample_id = Some("missing".into());
    assert!(bad.validate().is_err());
    let mut g = request(tmp.path(), &p, &["Une phrase."]).generation;
    g.options.intonation_guide = Some(tts::IntonationGuide {
        mode: "style".into(),
        track_id: None,
    });
    assert!(validate_generation(&g).is_err());
}
