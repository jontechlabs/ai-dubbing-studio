use super::*;
use serde_json::json;
struct Directory {
    _temp: tempfile::TempDir,
    root: std::path::PathBuf,
}
impl Directory {
    fn path(&self) -> &Path {
        &self.root
    }
}
fn directory() -> Directory {
    let sandbox = tempfile::tempdir().unwrap();
    let root = sandbox.path().canonicalize().unwrap();
    Directory {
        _temp: sandbox,
        root,
    }
}
fn fixture(root: &Path) -> (Project, Options) {
    let mut p = crate::tts_batch::tests::fixture(root, &["Ancien dialogue"]);
    p.media = Some(serde_json::from_value(json!({"id":"media", "path":"video/source.mkv", "previewPath":null, "audioStreamIndex":0, "originalName":"source.mkv", "durationMs":60000, "streams":[]})).unwrap());
    let mut second = p.voice_references[0].clone();
    second.id = "second".into();
    second.path = "characters/second.wav".into();
    second.transcript = "Oui".into();
    std::fs::write(root.join(&second.path), b"other reference").unwrap();
    p.voice_references.push(second);
    let o = Options {
        script: "[Speaker 1: Femme] Bonjour !\n[Speaker 2: Fille] Oui !".into(),
        start_ms: 10000,
        duration_ms: 3000,
        slots: Some(vec![
            Slot {
                start_ms: 10000,
                end_ms: 13000,
            },
            Slot {
                start_ms: 11000,
                end_ms: 12500,
            },
        ]),
        speakers: vec![
            Speaker {
                speaker: 1,
                name: "Femme".into(),
                character_id: None,
                reference_mode: "file".into(),
                reference_id: "ref".into(),
            },
            Speaker {
                speaker: 2,
                name: "Fille".into(),
                character_id: None,
                reference_mode: "file".into(),
                reference_id: "second".into(),
            },
        ],
        options: crate::tts_batch::tests::options(),
    };
    (p, o)
}
#[test]
fn parser_matches_shared_ui_fixtures() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../../tests/fixtures/speaker-scripts.json")).unwrap();
    for case in cases["valid"].as_array().unwrap() {
        assert_eq!(
            serde_json::to_value(parse(case["script"].as_str().unwrap()).unwrap()).unwrap(),
            case["turns"]
        );
    }
    for case in cases["invalid"].as_array().unwrap() {
        assert!(parse(case.as_str().unwrap()).is_err(), "{case}");
    }
}
#[test]
fn creates_overlapping_lanes_and_distinct_references_without_mutating_previous_work() {
    let root = directory();
    let (p, o) = fixture(root.path());
    let before = serde_json::to_value(&p).unwrap();
    let (next, ids, preview) = plan(&p, root.path(), &o).unwrap();
    assert_eq!(serde_json::to_value(&p).unwrap(), before);
    assert_eq!(next.dialogues.len(), p.dialogues.len() + 2);
    assert_eq!(next.target_cues.len(), p.target_cues.len() + 2);
    assert_eq!(
        serde_json::to_value(&next.source_cues).unwrap(),
        before["sourceCues"]
    );
    assert_eq!(
        serde_json::to_value(&next.generations).unwrap(),
        before["generations"]
    );
    assert_eq!(serde_json::to_value(&next.media).unwrap(), before["media"]);
    assert_ne!(
        crate::dubbing_lanes::lane(&next, &ids[0]),
        crate::dubbing_lanes::lane(&next, &ids[1])
    );
    assert_eq!(preview.turns[0].turn.text, "Bonjour !");
    for (index, id) in ids.iter().enumerate() {
        let line = next.dialogues.iter().find(|l| &l.id == id).unwrap();
        assert_eq!(
            line.voice_settings
                .as_ref()
                .unwrap()
                .reference_id
                .as_deref(),
            Some(if index == 0 { "ref" } else { "second" })
        );
    }
    let mut session = project::Session::new(root.path().into(), p.clone());
    let saved = session.replace(next, p.revision).unwrap();
    assert_eq!(project::load(root.path()).unwrap().id, saved.id);
    let restored = session.history(false).unwrap();
    assert_eq!(restored.dialogues.len(), p.dialogues.len());
    assert!(restored.dubbing_lanes.is_none());
}
#[test]
fn rejects_invalid_bounds_same_voice_overlap_missing_references_and_extra_speakers() {
    let root = directory();
    let (p, o) = fixture(root.path());
    for (start, end) in [
        (0, 99),
        (10000, 10000),
        (13000, 12000),
        (59000, 61000),
        (0, 120001),
    ] {
        let mut bad = o.clone();
        bad.slots.as_mut().unwrap()[0] = Slot {
            start_ms: start,
            end_ms: end,
        };
        assert_eq!(
            plan(&p, root.path(), &bad).err().as_deref(),
            Some("SCRIPT_TIMING_INVALID")
        );
    }
    let mut bad = o.clone();
    bad.script = "[Speaker 1] Bonjour\n[Speaker 1] Oui".into();
    bad.speakers.pop();
    assert_eq!(
        plan(&p, root.path(), &bad).err().as_deref(),
        Some("SCRIPT_SPEAKER_OVERLAP")
    );
    for mode in ["current", "character", "unknown"] {
        let mut bad = o.clone();
        bad.speakers[0].reference_mode = mode.into();
        assert!(plan(&p, root.path(), &bad).is_err());
    }
    let mut bad = o.clone();
    bad.speakers[0].reference_id = "missing".into();
    assert!(plan(&p, root.path(), &bad).is_err());
    let mut bad = o.clone();
    bad.speakers.push(bad.speakers[0].clone());
    assert!(plan(&p, root.path(), &bad).is_err());
    let mut bad = o.clone();
    bad.slots = Some(vec![]);
    assert!(plan(&p, root.path(), &bad).is_err());
}
#[test]
fn repeated_speaker_reuses_its_lane_and_sequential_defaults_are_bounded() {
    let root = directory();
    let (p, mut o) = fixture(root.path());
    o.script.push_str("\n[Speaker 1] Encore !");
    o.slots = None;
    let (next, ids, _) = plan(&p, root.path(), &o).unwrap();
    assert_eq!(
        crate::dubbing_lanes::lane(&next, &ids[0]),
        crate::dubbing_lanes::lane(&next, &ids[2])
    );
    o.start_ms = u64::MAX;
    assert!(plan(&p, root.path(), &o).is_err());
    o.start_ms = 0;
    o.duration_ms = 0;
    assert!(plan(&p, root.path(), &o).is_err());
}
#[test]
fn generation_uses_each_stored_reference_for_all_four_alternatives() {
    let root = directory();
    let (p, o) = fixture(root.path());
    let (next, ids, _) = plan(&p, root.path(), &o).unwrap();
    for count in 1..=4 {
        let items = requests(
            &next,
            root.path(),
            &Generation {
                line_ids: ids.clone(),
                take_count: count,
            },
        )
        .unwrap();
        assert_eq!(items.len(), 2 * count as usize);
        for (index, item) in items.iter().enumerate() {
            let speaker = index / count as usize;
            assert_eq!(item.request.line_id, ids[speaker]);
            assert_eq!(
                item.request.options.reference_id.as_deref(),
                Some(if speaker == 0 { "ref" } else { "second" })
            );
            assert_eq!(
                item.request.options.seed,
                o.options.seed + (index as u32 % count)
            );
        }
        assert_eq!(
            items
                .iter()
                .map(|i| i.request.batch_item_id.as_ref().unwrap())
                .collect::<HashSet<_>>()
                .len(),
            items.len()
        );
    }
    assert!(requests(
        &next,
        root.path(),
        &Generation {
            line_ids: vec![ids[0].clone(), ids[0].clone()],
            take_count: 1
        }
    )
    .is_err());
    assert!(requests(
        &next,
        root.path(),
        &Generation {
            line_ids: ids,
            take_count: 5
        }
    )
    .is_err());
}
#[test]
fn script_assignments_survive_automatic_character_routing_and_lane_capacity_is_atomic() {
    let root = directory();
    let (mut p, o) = fixture(root.path());
    p.format_version = 33;
    p.dubbing_lanes = Some(State {
        source_path: p.media.as_ref().unwrap().path.clone(),
        lanes: vec![Lane {
            id: MAIN.into(),
            name: "Principal".into(),
            mute: false,
            solo: false,
            gain: 1.0,
            character_id: None,
            character_name: None,
        }],
        assignments: HashMap::new(),
        by_character: Some(crate::dubbing_lanes::CharacterRouting {
            enabled: true,
            manual_line_ids: vec![],
        }),
    });
    let (mut next, ids, _) = plan(&p, root.path(), &o).unwrap();
    let before = serde_json::to_value(&next.dubbing_lanes).unwrap();
    crate::dubbing_lanes::normalize(&mut next).unwrap();
    assert_eq!(serde_json::to_value(&next.dubbing_lanes).unwrap(), before);
    for id in ids {
        assert!(next
            .dubbing_lanes
            .as_ref()
            .unwrap()
            .by_character
            .as_ref()
            .unwrap()
            .manual_line_ids
            .contains(&id));
    }
    let state = p.dubbing_lanes.as_mut().unwrap();
    for i in 1..MAX_LANES {
        let mut lane = state.lanes[0].clone();
        lane.id = format!("lane-{i}");
        state.lanes.push(lane);
    }
    assert_eq!(
        plan(&p, root.path(), &o).err().as_deref(),
        Some("DUBBING_LANES_LIMIT")
    );
    assert_eq!(p.dubbing_lanes.as_ref().unwrap().lanes.len(), MAX_LANES);
}
#[tokio::test]
async fn real_batch_protocol_preserves_each_reference_and_adds_takes_on_regeneration() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let (p, o) = fixture(&root);
    let (next, ids, _) = plan(&p, &root, &o).unwrap();
    let core = crate::tts_batch::tests::core(&root, next);
    let app = tauri::test::mock_app();
    for iteration in 0..2 {
        let current = core
            .session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .project
            .clone();
        let items = requests(
            &current,
            &root,
            &Generation {
                line_ids: ids.clone(),
                take_count: 2,
            },
        )
        .unwrap();
        let request = tts_batch::Request {
            take_count: Some(2),
            created_at: None,
            origin_batch_id: None,
            root: root.clone(),
            approved_only: false,
            unapproved_only: false,
            project_id: current.id.clone(),
            language: "fr".into(),
            items,
            skipped: 0,
        };
        let key = tts_batch::resume_with_launch(
            core.clone(),
            app.handle().clone(),
            request,
            Some(crate::tts_batch::tests::worker(&root)),
        )
        .unwrap();
        let job = crate::tts_batch::tests::finished(&core, &key).await;
        assert_eq!(job.status, "succeeded", "{:?}", job.error);
        let saved = project::load(&root).unwrap();
        assert_eq!(saved.generations.len(), 4 * (iteration + 1));
        assert_eq!(saved.dialogues.len(), current.dialogues.len());
        assert_eq!(
            serde_json::to_value(&saved.dubbing_lanes).unwrap(),
            serde_json::to_value(&current.dubbing_lanes).unwrap()
        );
        for (index, line) in ids.iter().enumerate() {
            assert!(saved
                .generations
                .iter()
                .filter(|g| g["dialogueId"] == *line)
                .all(|g| g["options"]["referenceId"] == if index == 0 { "ref" } else { "second" }));
        }
    }
    let calls = std::fs::read_to_string(root.join("calls.jsonl")).unwrap();
    let calls: Vec<serde_json::Value> = calls
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(calls.len(), 8);
    assert_eq!(
        calls
            .iter()
            .take(4)
            .map(|r| r["workerPid"].as_u64().unwrap())
            .collect::<HashSet<_>>()
            .len(),
        1
    );
    assert!(calls
        .iter()
        .all(|r| !r["text"].as_str().unwrap().contains("Speaker")));
    assert_ne!(calls[0]["referenceAudio"], calls[2]["referenceAudio"]);
}
#[test]
fn active_voice_job_blocks_creation_and_duplicate_generation_without_mutation() {
    let root = directory();
    let (p, o) = fixture(root.path());
    let ids = p.dialogues.iter().map(|line| line.id.clone()).collect();
    let core = crate::tts_batch::tests::core(root.path(), p.clone());
    let app = tauri::test::mock_app();
    crate::jobs::create(&core, app.handle(), "ttsBatch", p.id.clone(), None);
    assert_eq!(
        create(&core, app.handle(), &p.id, p.revision, &o)
            .err()
            .as_deref(),
        Some("BUSY")
    );
    assert_eq!(
        enqueue(
            core.clone(),
            app.handle().clone(),
            &p.id,
            p.revision,
            &Generation {
                line_ids: ids,
                take_count: 1
            }
        )
        .err()
        .as_deref(),
        Some("BUSY")
    );
    assert_eq!(core.jobs.lock().unwrap().len(), 1);
    assert_eq!(
        serde_json::to_value(&core.session.lock().unwrap().as_ref().unwrap().project).unwrap(),
        serde_json::to_value(p).unwrap()
    );
}
