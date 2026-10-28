use super::*;
use std::{collections::HashMap, sync::Mutex};
fn fixture() -> Project {
    let mut p = Project::new("Toolbox 日本語".into(), "ja".into(), "fr".into());
    p.media=Some(serde_json::from_value(json!({"id":"video","path":"media/source.wav","previewPath":null,"audioStreamIndex":0,"originalName":"source.wav","durationMs":16000,"streams":[]})).unwrap());
    p
}
fn options() -> Options {
    Options {
        model_id: "mel-band-roformer-kim".into(),
        source_track_id: "original".into(),
        start_ms: 7000,
        end_ms: 8000,
        device: "cpu".into(),
        prompt: String::new(),
        window_seconds: 4,
    }
}
fn wave(path: &Path) {
    silence(path).unwrap();
    let mut bytes = std::fs::read(path).unwrap();
    for i in (44..bytes.len()).step_by(2) {
        bytes[i..i + 2].copy_from_slice(&6000i16.to_le_bytes());
    }
    std::fs::write(path, bytes).unwrap();
}
#[test]
fn ranges_devices_and_prompts_are_checked_before_processing() {
    let p = fixture();
    let app = tauri::test::mock_app();
    let m = model(app.handle(), "mel-band-roformer-kim").unwrap();
    let good = options();
    validate(&p, &good, &m).unwrap();
    for (start, end) in [(0, 99), (2000, 2000), (1000, 999), (0, 60001), (0, 16001)] {
        let mut o = good.clone();
        o.start_ms = start;
        o.end_ms = end;
        assert!(validate(&p, &o, &m).is_err());
    }
    for d in ["cuda:100", "cuda:-1", "cuda:+1", "cuda:aa", "vulkan:0"] {
        let mut o = good.clone();
        o.device = d.into();
        assert!(validate(&p, &o, &m).is_err());
    }
    let mut o = good;
    o.model_id = "audiosep".into();
    let m = model(app.handle(), "audiosep").unwrap();
    assert_eq!(validate(&p, &o, &m).unwrap_err(), "AUDIO_TOOLBOX_PROMPT");
    o.prompt = "Footsteps".into();
    validate(&p, &o, &m).unwrap();
}
#[test]
fn fingerprint_rejects_source_file_regions_stream_and_patch_changes_but_keeps_text_edits() {
    let temp = tempfile::tempdir().unwrap();
    let root = project::create_root(temp.path(), "source").unwrap();
    wave(&root.join("media/source.wav"));
    let p = fixture();
    let o = options();
    let before = snapshot(&p, &root, &o).unwrap();
    let mut edited = p.clone();
    edited.name = "Text-only rename".into();
    assert_eq!(snapshot(&edited, &root, &o).unwrap(), before);
    edited.media.as_mut().unwrap().audio_stream_index = Some(1);
    assert_ne!(snapshot(&edited, &root, &o).unwrap(), before);
    let mut bytes = std::fs::read(root.join("media/source.wav")).unwrap();
    bytes.push(0);
    std::fs::write(root.join("media/source.wav"), bytes).unwrap();
    assert_ne!(snapshot(&p, &root, &o).unwrap(), before);
}
#[tokio::test]
async fn apply_creates_missing_tracks_at_original_timestamp_preserves_media_and_is_undoable() {
    let temp = tempfile::tempdir().unwrap();
    let root = project::create_root(temp.path(), "Audio 日本語").unwrap();
    wave(&root.join("media/source.wav"));
    let source = std::fs::read(root.join("media/source.wav")).unwrap();
    let p = fixture();
    let core = Arc::new(Core {
        data_dir: temp.path().into(),
        model_dir: Mutex::new(temp.path().into()),
        session: Mutex::new(Some(project::Session::new(root.clone(), p.clone()))),
        jobs: Mutex::new(HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
    });
    let app = tauri::test::mock_app();
    let key = jobs::create(&core, app.handle(), "audioToolbox", p.id.clone(), None);
    let o = options();
    let fingerprint = snapshot(&p, &root, &o).unwrap();
    {
        let mut jobs = core.jobs.lock().unwrap();
        let j = jobs.get_mut(&key).unwrap();
        j.saved.record.status = "succeeded".into();
        j.saved.toolbox_request = Some(Request {
            root: root.clone(),
            project_id: p.id.clone(),
            source_path: p.media.as_ref().unwrap().path.clone(),
            snapshot: fingerprint,
            options: o,
        });
    }
    let cache = root.join(format!("cache/audio-toolbox/{key}"));
    std::fs::create_dir_all(&cache).unwrap();
    wave(&cache.join("vocals.wav"));
    wave(&cache.join("instrumental.wav"));
    project::atomic_write(
        &cache.join("result.json"),
        br#"{"commonGain":1,"deviceName":"CPU"}"#,
    )
    .unwrap();
    assert_eq!(result(&core, app.handle(), &key).unwrap()["stale"], false);
    let destinations = || {
        vec![
            Destination {
                output_id: "vocals".into(),
                track_id: None,
                role: Some("speech".into()),
            },
            Destination {
                output_id: "instrumental".into(),
                track_id: None,
                role: Some("music".into()),
            },
        ]
    };
    let mut bad = destinations();
    bad[1].role = Some("speech".into());
    assert!(
        apply(core.clone(), app.handle().clone(), key.clone(), bad, true)
            .await
            .is_err()
    );
    assert!(core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .tracks
        .is_empty());
    std::fs::write(cache.join("instrumental.wav"), b"invalid").unwrap();
    assert!(apply(
        core.clone(),
        app.handle().clone(),
        key.clone(),
        destinations(),
        true
    )
    .await
    .is_err());
    assert!(core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .generations
        .is_empty());
    wave(&cache.join("instrumental.wav"));
    let saved = apply(
        core.clone(),
        app.handle().clone(),
        key.clone(),
        destinations(),
        true,
    )
    .await
    .unwrap();
    assert_eq!(saved.format_version, 23);
    assert_eq!(saved.tracks.len(), 2);
    assert_eq!(saved.generations.len(), 3);
    assert!(saved
        .generations
        .iter()
        .all(|g| g["startMs"] == 7000 && g["endMs"] == 8000));
    assert_eq!(
        std::fs::read(root.join("media/source.wav")).unwrap(),
        source
    );
    assert_eq!(result(&core, app.handle(), &key).unwrap()["applied"], true);
    // A one-second silent base must still permit a patch much later in the movie.
    let out = root.join("audition.wav");
    let track = saved.tracks[0].id.clone();
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        audio_patch::snippet(
            &core,
            app.handle(),
            &key,
            &saved,
            &root,
            audio_patch::Snippet {
                track_id: &track,
                start_ms: 7000,
                end_ms: 8000,
                channels: 2,
                rate: 48000,
                fader: false,
            },
            &out,
            &AtomicBool::new(false),
        ),
    )
    .await
    .expect("A late patch must terminate even with an EOF base")
    .unwrap();
    assert_eq!(crate::audio_files::wav_frames(&out).unwrap(), 48000);
    let rendered = std::fs::read(out).unwrap();
    let data = rendered.windows(4).position(|w| w == b"data").unwrap() + 8;
    assert!(rendered[data..]
        .chunks_exact(2)
        .any(|b| i16::from_le_bytes([b[0], b[1]]).unsigned_abs() > 1000));
    assert!(apply(
        core.clone(),
        app.handle().clone(),
        key.clone(),
        destinations(),
        true
    )
    .await
    .is_err());
    let mut guard = core.session.lock().unwrap();
    let s = guard.as_mut().unwrap();
    assert!(s.history(false).unwrap().generations.is_empty());
    assert_eq!(s.history(true).unwrap().generations.len(), 3);
    assert!(cache.join("vocals.wav").exists());
    assert_eq!(
        std::fs::read(root.join("media/source.wav")).unwrap(),
        source
    );
}
