use super::*;

pub(super) fn fixture() -> (Project, Options, Model) {
    let mut p = Project::new("Free speaker selection".into(), "ja".into(), "fr".into());
    p.media = Some(serde_json::from_value(json!({"id":"video","path":"media/source.wav","previewPath":null,"audioStreamIndex":0,"originalName":"source.wav","durationMs":16000,"streams":[]})).unwrap());
    let o = serde_json::from_value(json!({"modelId":"mossformer2-16k","sourceTrackId":"original","startMs":7100,"endMs":8100,"device":"cpu","windowSeconds":4,"prompt":""})).unwrap();
    let m = Model {
        id: "mossformer2-16k".into(),
        name: "MossFormer2".into(),
        family: "mossformer2".into(),
        speakers: 2,
        speaker_counts: vec![],
        files: vec![],
        outputs: vec!["voice-1".into(), "voice-2".into()],
        license: String::new(),
        source: String::new(),
    };
    (p, o, m)
}

#[test]
fn free_selection_without_dialogue_keeps_range_device_and_track_guards() {
    let (p, o, m) = fixture();
    assert!(o.line_id.is_none());
    assert!(serde_json::to_value(&o).unwrap().get("lineId").is_none());
    validate(&p, &o, &m).unwrap();
    for (start, end) in [(0, 99), (1000, 1000), (2000, 1000), (0, 60001), (0, 16001)] {
        let mut bad = o.clone();
        bad.start_ms = start;
        bad.end_ms = end;
        assert!(validate(&p, &bad, &m).is_err());
    }
    for device in ["cuda:-1", "cuda:aa", "vulkan:0"] {
        let mut bad = o.clone();
        bad.device = device.into();
        assert_eq!(validate(&p, &bad, &m).unwrap_err(), "DEVICE_UNAVAILABLE");
    }
    let mut bad = o;
    bad.source_track_id = "missing".into();
    assert!(validate(&p, &bad, &m).is_err());
    assert!(p.dialogues.is_empty());
}

#[test]
fn dialogue_bound_separation_still_requires_exact_existing_dialogue_bounds() {
    let (mut p, mut o, m) = fixture();
    p.dialogues.push(serde_json::from_value(json!({"id":"line","startMs":7100,"endMs":8100,"sourceCueIds":[],"targetCueIds":[],"ttsText":null,"characterId":null,"status":"ungenerated","warnings":[],"selectedGenerationIds":{}})).unwrap());
    o.line_id = Some("line".into());
    validate(&p, &o, &m).unwrap();
    o.start_ms = 7200;
    assert_eq!(
        validate(&p, &o, &m).unwrap_err(),
        "SPEAKER_SEPARATION_OPTIONS"
    );
    o.line_id = Some("missing".into());
    assert_eq!(validate(&p, &o, &m).unwrap_err(), "INVALID_PROJECT");
    o.line_id = None;
    validate(&p, &o, &m).unwrap();
    assert_eq!(p.dialogues[0].start_ms, 7100);
}

#[test]
fn spectral_models_freeze_allowed_counts_and_reject_unknown_profiles_without_changing_legacy_defaults(
) {
    let (p, mut options, _) = fixture();
    let app = tauri::test::mock_app();
    for (name, counts) in [
        ("tf-gridnet-wsj0-2mix", vec![2]),
        ("sr-corrnet-whamr-2spk", vec![2]),
        ("sr-corrnet-wsj-2-3spk", vec![2, 3]),
        ("sr-corrnet-wsj-2-5spk", vec![2, 3, 4, 5]),
    ] {
        options.model_id = name.into();
        options.speaker_count = None;
        let default = configured_model(app.handle(), &options).unwrap();
        assert_eq!(default.speakers, 2);
        assert_eq!(default.speaker_counts, counts);
        for n in 1..=6 {
            options.speaker_count = Some(n);
            let model = configured_model(app.handle(), &options);
            assert_eq!(model.is_ok(), counts.contains(&(n as usize)));
            if let Ok(m) = model {
                assert_eq!(m.outputs.len(), n as usize);
                validate(&p, &options, &m).unwrap();
            }
        }
    }
    options.model_id = "mossformer2-16k".into();
    options.speaker_count = None;
    let m = configured_model(app.handle(), &options).unwrap();
    assert_eq!(m.speakers, 2);
    options.memory_profile = Some("fp16".into());
    assert_eq!(
        validate(&p, &options, &m).unwrap_err(),
        "SPEAKER_SEPARATION_OPTIONS"
    );
    options.memory_profile = None;
    assert!(serde_json::to_value(&options)
        .unwrap()
        .get("speakerCount")
        .is_none());
    assert!(serde_json::to_value(&options)
        .unwrap()
        .get("memoryProfile")
        .is_none());
}
