use super::*;

fn fixture() -> (Project, Options, Model) {
    let mut p = Project::new("Free speaker selection".into(), "ja".into(), "fr".into());
    p.media = Some(serde_json::from_value(json!({"id":"video","path":"media/source.wav","previewPath":null,"audioStreamIndex":0,"originalName":"source.wav","durationMs":16000,"streams":[]})).unwrap());
    let o = serde_json::from_value(json!({"modelId":"mossformer2-16k","sourceTrackId":"original","startMs":7100,"endMs":8100,"device":"cpu","windowSeconds":4,"prompt":""})).unwrap();
    let m = Model {
        id: "mossformer2-16k".into(),
        name: "MossFormer2".into(),
        family: "mossformer2".into(),
        speakers: 2,
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
