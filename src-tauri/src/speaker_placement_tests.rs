use super::*;
use std::sync::Mutex;
fn fixture() -> (Project, Request, Model) {
    let (p, o, m) = super::super::selection_tests::fixture();
    let r = Request {
        root: PathBuf::from("unused"),
        project_id: p.id.clone(),
        source_path: p.media.as_ref().unwrap().path.clone(),
        options: o,
        snapshot: Value::Null,
    };
    (p, r, m)
}
fn assignment(output: &str) -> Placement {
    Placement {
        output_id: output.into(),
        label: output.into(),
        character_id: None,
        source_text: "叫び声".into(),
        target_text: "Au secours !".into(),
        lane_id: None,
        lane_name: format!("Isolée {output}"),
    }
}
#[test]
fn free_region_creates_simultaneous_independent_takes_without_touching_subtitles() {
    let (p, r, m) = fixture();
    let (next, files) = plan(
        &p,
        &r,
        &m,
        "job",
        "ja",
        vec![assignment("voice-1"), assignment("voice-2")],
    )
    .unwrap();
    assert_eq!(next.format_version, 34);
    assert_eq!(next.dialogues.len(), 3);
    assert_eq!(next.generations.len(), 2);
    assert_eq!(files.len(), 2);
    assert_eq!(
        serde_json::to_value(&next.source_cues).unwrap(),
        serde_json::to_value(&p.source_cues).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&next.target_cues).unwrap(),
        serde_json::to_value(&p.target_cues).unwrap()
    );
    assert!(p.dialogues.is_empty());
    let voices = &next.speaker_dubbings[0].voices;
    assert_ne!(
        crate::dubbing_lanes::lane(&next, &voices[0].line_id),
        crate::dubbing_lanes::lane(&next, &voices[1].line_id)
    );
    for voice in voices {
        let line = next
            .dialogues
            .iter()
            .find(|l| l.id == voice.line_id)
            .unwrap();
        assert!(line.source_cue_ids.is_empty() && line.target_cue_ids.is_empty());
        assert_eq!((line.start_ms, line.end_ms), (7100, 8100));
        assert!(line.selected_generation_ids.contains_key("fr"));
    }
    for g in &next.generations {
        assert_eq!(g["takeOrigin"]["sourceLanguage"], "ja");
        assert_eq!(g["providerId"], "speaker-separation");
    }
    assert_eq!(crate::mix::clips(&next).len(), 2);
}
#[test]
fn additional_output_reuses_group_and_existing_children_and_preserves_takes() {
    let (p, r, m) = fixture();
    let (first, _) = plan(&p, &r, &m, "job", "ja", vec![assignment("voice-1")]).unwrap();
    let (second, _) = plan(&first, &r, &m, "job", "ja", vec![assignment("voice-2")]).unwrap();
    assert_eq!(second.dialogues.len(), 3);
    assert_eq!(second.speaker_dubbings.len(), 1);
    assert_eq!(second.generations[0], first.generations[0]);
    assert_eq!(placed(&second, "job").len(), 2);
    assert!(
        matches!(plan(&second,&r,&m,"job","ja",vec![assignment("voice-1")]),Err(e) if e=="SPEAKER_SEPARATION_ALREADY_APPLIED")
    );
    // Prepared sub-dialogues need a take, not a duplicate dialogue. A trimmed
    // child receives only its matching source portion at its own timestamp.
    let mut prepared = second.clone();
    prepared.generations.clear();
    for l in &mut prepared.dialogues {
        l.selected_generation_ids.clear();
        l.status = "ungenerated".into();
    }
    let child = prepared.speaker_dubbings[0].voices[0].line_id.clone();
    let l = prepared
        .dialogues
        .iter_mut()
        .find(|l| l.id == child)
        .unwrap();
    l.start_ms += 100;
    l.end_ms -= 100;
    let (placed, files) =
        plan(&prepared, &r, &m, "job", "ja", vec![assignment("voice-1")]).unwrap();
    assert_eq!(placed.dialogues.len(), 3);
    assert_eq!(files[0].offset_ms, 100);
    assert_eq!(files[0].duration_ms, 800);
}
#[test]
fn explicit_destination_survives_character_routing_and_main_override() {
    let (p, r, m) = fixture();
    let (mut next, _) = plan(&p, &r, &m, "job", "ja", vec![assignment("voice-1")]).unwrap();
    next = crate::dubbing_lanes::configure(
        &next,
        &crate::dubbing_lanes::Options {
            enabled: true,
            preserve_manual: true,
        },
    )
    .unwrap();
    let mut a = assignment("voice-2");
    a.lane_id = Some(MAIN.into());
    let (mut placed, _) = plan(&next, &r, &m, "job", "ja", vec![a]).unwrap();
    let child = placed.speaker_dubbings[0].voices[1].line_id.clone();
    crate::dubbing_lanes::normalize(&mut placed).unwrap();
    assert_eq!(crate::dubbing_lanes::lane(&placed, &child), MAIN);
    assert!(placed
        .dubbing_lanes
        .as_ref()
        .unwrap()
        .by_character
        .as_ref()
        .unwrap()
        .manual_line_ids
        .contains(&child));
}
#[test]
fn rejects_partial_invalid_duplicate_and_over_capacity_without_mutation() {
    let (p, r, m) = fixture();
    let before = serde_json::to_value(&p).unwrap();
    for bad in ["missing", "voice-3"] {
        assert!(plan(&p, &r, &m, "job", "ja", vec![assignment(bad)]).is_err());
    }
    assert!(plan(
        &p,
        &r,
        &m,
        "job",
        "ja",
        vec![assignment("voice-1"), assignment("voice-1")]
    )
    .is_err());
    assert!(plan(&p, &r, &m, "job", "en", vec![assignment("voice-1")]).is_err());
    let mut a = assignment("voice-1");
    a.lane_id = Some("missing".into());
    assert!(plan(&p, &r, &m, "job", "ja", vec![a]).is_err());
    let (mut full, _) = plan(&p, &r, &m, "job", "ja", vec![assignment("voice-1")]).unwrap();
    let template = full.dubbing_lanes.as_ref().unwrap().lanes[1].clone();
    while full.dubbing_lanes.as_ref().unwrap().lanes.len() < MAX_LANES {
        let mut lane = template.clone();
        lane.id = id();
        full.dubbing_lanes.as_mut().unwrap().lanes.push(lane);
    }
    assert!(plan(&full, &r, &m, "job", "ja", vec![assignment("voice-2")]).is_err());
    assert_eq!(serde_json::to_value(&p).unwrap(), before);
}
#[test]
fn separation_origin_requires_new_format_and_complete_provenance() {
    let (p, r, m) = fixture();
    let (next, _) = plan(&p, &r, &m, "job", "ja", vec![assignment("voice-1")]).unwrap();
    let mut old = next.clone();
    old.format_version = 33;
    assert!(old.validate().is_err());
    for field in [
        "separationId",
        "outputId",
        "sourceTrackId",
        "sourceLanguage",
    ] {
        let mut bad = next.clone();
        bad.generations[0]["takeOrigin"][field] = json!("");
        assert!(bad.validate().is_err());
    }
}

fn mono(path: &Path) {
    let mut b = vec![];
    b.extend(b"RIFF");
    b.extend(96036u32.to_le_bytes());
    b.extend(b"WAVEfmt ");
    b.extend(16u32.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(48000u32.to_le_bytes());
    b.extend(96000u32.to_le_bytes());
    b.extend(2u16.to_le_bytes());
    b.extend(16u16.to_le_bytes());
    b.extend(b"data");
    b.extend(96000u32.to_le_bytes());
    for _ in 0..48000 {
        b.extend(6000i16.to_le_bytes());
    }
    std::fs::write(path, b).unwrap();
}
async fn setup() -> (
    tempfile::TempDir,
    Arc<Core>,
    tauri::App<tauri::test::MockRuntime>,
    String,
    PathBuf,
) {
    let temp = tempfile::tempdir().unwrap();
    let root = project::create_root(temp.path(), "Isolated 日本語").unwrap();
    super::super::silence(&root.join("media/source.wav")).unwrap();
    let (p, mut r, _) = fixture();
    r.root = root.clone();
    r.snapshot = super::super::snapshot(&p, &root, &r.options).unwrap();
    let core = Arc::new(Core {
        data_dir: temp.path().join("data"),
        model_dir: Mutex::new(temp.path().join("models")),
        session: Mutex::new(Some(project::Session::new(root.clone(), p.clone()))),
        jobs: Mutex::new(HashMap::new()),
        gate: Arc::new(tokio::sync::Semaphore::new(1)),
        queue: Mutex::new(crate::task_queue::State::default()),
    });
    let app = tauri::test::mock_app();
    let key = jobs::create(&core, app.handle(), "speakerSeparation", p.id, None);
    {
        let mut jobs = core.jobs.lock().unwrap();
        let j = jobs.get_mut(&key).unwrap();
        j.saved.record.status = "succeeded".into();
        j.saved.speaker_separation_request = Some(r);
    }
    let cache = root.join(format!("cache/speaker-separation/{key}"));
    std::fs::create_dir_all(&cache).unwrap();
    mono(&cache.join("voice-1.wav"));
    mono(&cache.join("voice-2.wav"));
    std::fs::write(
        cache.join("result.json"),
        br#"{"commonGain":1,"deviceName":"Synthetic fixture"}"#,
    )
    .unwrap();
    (temp, core, app, key, root)
}
#[tokio::test]
async fn actual_placement_resamples_exact_frames_persists_reopens_and_undoes_atomically() {
    let (_temp, core, app, key, root) = setup().await;
    let original = std::fs::read(root.join("media/source.wav")).unwrap();
    let first = place(
        core.clone(),
        app.handle().clone(),
        key.clone(),
        "ja".into(),
        vec![assignment("voice-1")],
    )
    .await
    .unwrap();
    assert_eq!(
        crate::audio_files::pcm_frames(
            &root.join(first.generations[0]["path"].as_str().unwrap()),
            1,
            24000,
            "BAD"
        )
        .unwrap(),
        24000
    );
    assert_eq!(
        super::super::result(&core, app.handle(), &key).unwrap()["stale"],
        false
    );
    let second = place(
        core.clone(),
        app.handle().clone(),
        key.clone(),
        "ja".into(),
        vec![assignment("voice-2")],
    )
    .await
    .unwrap();
    assert_eq!(second.generations[0], first.generations[0]);
    assert_eq!(second.dialogues.len(), 3);
    assert_eq!(
        std::fs::read(root.join("media/source.wav")).unwrap(),
        original
    );
    let reopened = project::load(&root).unwrap();
    assert_eq!(
        serde_json::to_value(&reopened).unwrap(),
        serde_json::to_value(&second).unwrap()
    );
    assert_eq!(crate::mix::clips(&second).len(), 2);
    let result = super::super::result(&core, app.handle(), &key).unwrap();
    assert_eq!(result["placedOutputIds"].as_array().unwrap().len(), 2);
    let take_path = root.join(second.generations[1]["path"].as_str().unwrap());
    let mut guard = core.session.lock().unwrap();
    let s = guard.as_mut().unwrap();
    let undone = s.history(false).unwrap();
    assert_eq!(undone.generations, first.generations);
    assert!(take_path.exists());
}
#[tokio::test]
async fn corrupt_later_output_rolls_back_staged_assets_and_keeps_project_unchanged() {
    let (_temp, core, app, key, root) = setup().await;
    let before = core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .clone();
    std::fs::write(
        root.join(format!("cache/speaker-separation/{key}/voice-2.wav")),
        b"bad",
    )
    .unwrap();
    assert!(place(
        core.clone(),
        app.handle().clone(),
        key,
        "ja".into(),
        vec![assignment("voice-1"), assignment("voice-2")]
    )
    .await
    .is_err());
    assert_eq!(
        serde_json::to_value(&core.session.lock().unwrap().as_ref().unwrap().project).unwrap(),
        serde_json::to_value(&before).unwrap()
    );
    for dir in ["stems", "generations"] {
        assert_eq!(std::fs::read_dir(root.join(dir)).unwrap().count(), 0);
    }
}

#[tokio::test]
async fn five_spectral_streams_create_five_exact_takes_tracks_and_survive_reopen_without_losing_source(
) {
    let (_temp, core, app, key, root) = setup().await;
    let original = std::fs::read(root.join("media/source.wav")).unwrap();
    {
        let mut jobs = core.jobs.lock().unwrap();
        let r = jobs
            .get_mut(&key)
            .unwrap()
            .saved
            .speaker_separation_request
            .as_mut()
            .unwrap();
        r.options.model_id = "sr-corrnet-wsj-2-5spk".into();
        r.options.speaker_count = Some(5);
        r.options.memory_profile = Some("gpu16".into());
    }
    for n in 3..=5 {
        mono(&root.join(format!("cache/speaker-separation/{key}/voice-{n}.wav")));
    }
    let placed = place(
        core.clone(),
        app.handle().clone(),
        key.clone(),
        "ja".into(),
        (1..=5).map(|n| assignment(&format!("voice-{n}"))).collect(),
    )
    .await
    .unwrap();
    assert_eq!(placed.format_version, 35);
    assert_eq!(placed.generations.len(), 5);
    assert_eq!(placed.speaker_dubbings[0].voices.len(), 5);
    assert_eq!(placed.dubbing_lanes.as_ref().unwrap().lanes.len(), 6);
    assert_eq!(crate::mix::clips(&placed).len(), 5);
    for g in &placed.generations {
        assert_eq!(
            crate::audio_files::pcm_frames(
                &root.join(g["path"].as_str().unwrap()),
                1,
                24000,
                "BAD"
            )
            .unwrap(),
            24000
        );
    }
    assert_eq!(
        std::fs::read(root.join("media/source.wav")).unwrap(),
        original
    );
    assert_eq!(
        serde_json::to_value(project::load(&root).unwrap()).unwrap(),
        serde_json::to_value(&placed).unwrap()
    );
    assert_eq!(
        super::super::result(&core, app.handle(), &key).unwrap()["outputs"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
    let mut old = placed.clone();
    old.format_version = 34;
    assert!(old.validate().is_err());
    // A two-output model must never accept output #5 by merely hiding the others.
    let mut bad = placed;
    bad.speaker_dubbings[0].model_id = "tf-gridnet-wsj0-2mix".into();
    let last = bad.speaker_dubbings[0].voices.pop().unwrap();
    bad.speaker_dubbings[0].voices = vec![last];
    assert!(bad.validate().is_err());
}
