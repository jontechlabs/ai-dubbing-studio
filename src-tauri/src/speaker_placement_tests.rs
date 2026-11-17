use super::*;
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
