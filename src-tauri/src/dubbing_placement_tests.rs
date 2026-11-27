use super::*;
use serde_json::json;

#[tokio::test]
async fn shared_browser_native_duration_and_routing_cases() {
    let (_temp, _root, template) = crate::mix::tests::fixture().await;
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/natural-dubbing-placement.json"
    ))
    .unwrap();
    for spec in cases.as_array().unwrap() {
        let mut p = template.clone();
        p.media.as_mut().unwrap().info.duration_ms = 16000;
        p.dialogues.clear();
        p.generations.clear();
        for (i, start) in spec["starts"].as_array().unwrap().iter().enumerate() {
            let mut line = template.dialogues[0].clone();
            line.id = format!("line-{i}");
            line.start_ms = start.as_u64().unwrap();
            line.end_ms = line.start_ms + 100;
            line.selected_generation_ids
                .insert("fr".into(), format!("take-{i}"));
            let mut g = template.generations[0].clone();
            g["id"] = json!(format!("take-{i}"));
            g["dialogueId"] = json!(line.id);
            g["startMs"] = json!(line.start_ms);
            g["endMs"] = json!(line.end_ms);
            g["durationMs"] = spec["durations"][i].clone();
            p.dialogues.push(line);
            p.generations.push(g);
        }
        if let Some(values) = spec["overrides"].as_object() {
            p.format_version = p.format_version.max(7);
            p.dubbing_timing = Some(serde_json::from_value(json!({"sourcePath":p.media.as_ref().unwrap().path,"offsetsMs":{},"durationsMs":values.iter().map(|(i, d)| (format!("line-{i}"), json!({"fr":d}))).collect::<serde_json::Map<_,_>>()})).unwrap());
        }
        p.validate().unwrap();
        let mut before = p.clone();
        for (i, line) in before.dialogues.iter_mut().enumerate() {
            if !spec["existing"].as_array().unwrap().contains(&json!(i)) {
                line.selected_generation_ids.remove("fr");
            }
        }
        let original = p.clone();
        resolve(&before, &mut p).unwrap();
        p.validate().unwrap();
        let lane_ids = lanes::current(&p)
            .map(|s| s.lanes.iter().map(|l| l.id.clone()).collect())
            .unwrap_or(vec![lanes::MAIN.to_owned()]);
        let assignments: Vec<_> = p
            .dialogues
            .iter()
            .map(|l| {
                lane_ids
                    .iter()
                    .position(|id| id == lanes::lane(&p, &l.id))
                    .unwrap()
            })
            .collect();
        assert_eq!(json!(assignments), spec["lanes"], "{}", spec["name"]);
        let clips: HashMap<_, _> = mix::clips(&p)
            .into_iter()
            .map(|c| (c.line_id.clone(), c))
            .collect();
        let lengths: Vec<_> = p
            .dialogues
            .iter()
            .map(|l| clips[&l.id].duration_ms())
            .collect();
        assert_eq!(json!(lengths), spec["lengths"], "{}", spec["name"]);
        assert_eq!(p.generations, original.generations);
        assert_eq!(json!(p.source_cues), json!(original.source_cues));
        let stable = p.clone();
        resolve(&stable, &mut p).unwrap();
        assert_eq!(json!(p), json!(stable));
    }
}

#[tokio::test]
async fn session_commits_new_takes_without_inheriting_short_timing_and_reopens_with_undo() {
    let (_temp, root, mut p) = crate::mix::tests::fixture().await;
    p.format_version = 7;
    p.dubbing_timing = Some(serde_json::from_value(json!({"sourcePath":p.media.as_ref().unwrap().path,"offsetsMs":{},"durationsMs":{"line":{"fr":100}}})).unwrap());
    let old = p.clone();
    let mut session = crate::project::Session::new(root.clone(), p.clone());
    let mut g = p.generations[0].clone();
    g["id"] = json!("new-take");
    p.generations.push(g);
    p.dialogues[0]
        .selected_generation_ids
        .insert("fr".into(), "new-take".into());
    let saved = session.replace(p, old.revision).unwrap();
    assert_eq!(mix::clips(&saved)[0].duration_ms(), 1500);
    assert!(!mix::clips(&saved)[0].exact_duration);
    assert_eq!(saved.generations.len(), old.generations.len() + 1);
    assert_eq!(
        mix::clips(&crate::project::load(&root).unwrap())[0].duration_ms(),
        1500
    );
    assert_eq!(
        mix::clips(&session.history(false).unwrap())[0].duration_ms(),
        100
    );
    assert_eq!(
        mix::clips(&session.history(true).unwrap())[0].duration_ms(),
        1500
    );
}

#[tokio::test]
async fn natural_wav_is_never_resampled_by_short_slot_or_submillisecond_metadata() {
    let (_temp, root, p) = crate::mix::tests::fixture().await;
    let source = root.join("generations/voice.wav").canonicalize().unwrap();
    let original = std::fs::read(&source).unwrap();
    // A nonexistent FFmpeg executable proves that no tempo filter is invoked.
    let result = crate::voice_fit::take_with_duration(
        &root,
        "generations/voice.wav",
        100,
        false,
        std::path::Path::new("unused-ffmpeg"),
        &std::sync::atomic::AtomicBool::new(false),
    )
    .await
    .unwrap();
    assert_eq!(result, source);
    assert_eq!(std::fs::read(result).unwrap(), original);
    assert_eq!(mix::clips(&p)[0].duration_ms(), 1500);
}

#[tokio::test]
async fn lane_capacity_failure_keeps_every_saved_take_timing_and_revision_unchanged() {
    let (_temp, root, template) = crate::mix::tests::fixture().await;
    let mut p = template.clone();
    p.format_version = 33;
    p.dialogues.clear();
    p.generations.clear();
    for i in 0..257 {
        let mut line = template.dialogues[0].clone();
        line.id = format!("line-{i}");
        line.selected_generation_ids.clear();
        if i < 256 {
            line.selected_generation_ids
                .insert("fr".into(), format!("take-{i}"));
        }
        let mut g = template.generations[0].clone();
        g["id"] = json!(format!("take-{i}"));
        g["dialogueId"] = json!(line.id);
        p.dialogues.push(line);
        p.generations.push(g);
    }
    p.dubbing_lanes = Some(lanes::State {
        source_path: p.media.as_ref().unwrap().path.clone(),
        lanes: (0..256)
            .map(|i| lanes::Lane {
                id: if i == 0 {
                    "main".into()
                } else {
                    format!("lane-{i}")
                },
                name: format!("Voice {}", i + 1),
                mute: false,
                solo: false,
                gain: 1.0,
                character_id: None,
                character_name: None,
            })
            .collect(),
        assignments: (1..256)
            .map(|i| (format!("line-{i}"), format!("lane-{i}")))
            .collect(),
        by_character: None,
    });
    crate::project::save(&root, &p).unwrap();
    let original = std::fs::read(root.join("project.json")).unwrap();
    let mut session = crate::project::Session::new(root.clone(), p.clone());
    let mut next = p.clone();
    next.dialogues[256]
        .selected_generation_ids
        .insert("fr".into(), "take-256".into());
    assert_eq!(
        session.replace(next, p.revision).unwrap_err(),
        "DUBBING_LANES_LIMIT"
    );
    assert_eq!(json!(session.project), json!(p));
    assert_eq!(std::fs::read(root.join("project.json")).unwrap(), original);
}
