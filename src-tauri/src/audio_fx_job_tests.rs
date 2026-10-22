use super::*;
fn options(track: &str, scope: &str) -> Options {
    Options {
        track_id: track.into(),
        scope: scope.into(),
        start_ms: 0,
        end_ms: if scope == "track" { 4000 } else { 1000 },
        effects: vec![serde_json::from_value(
            serde_json::json!({"kind":"equalizer","enabled":true,"parameters":{}}),
        )
        .unwrap()],
        replace_in_mix: true,
        name: Some("Piste traitée · FX".into()),
    }
}
async fn finish(core: &Core, id: &str) -> jobs::Job {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(45);
    loop {
        let record = core.jobs.lock().unwrap()[id].snapshot();
        if !["queued", "running"].contains(&record.status.as_str()) {
            return record;
        }
        assert!(std::time::Instant::now() < deadline, "job timed out");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}
#[tokio::test]
async fn whole_original_stem_and_dubbing_effect_copies_preserve_sources_and_mixer_controls() {
    let (_dir, root, p) = crate::mix::tests::fixture().await;
    let original = std::fs::read(root.join("media/source.mkv")).unwrap();
    let music = std::fs::read(root.join("stems/music.wav")).unwrap();
    let voice = std::fs::read(root.join("generations/voice.wav")).unwrap();
    for id in ["original", "music", "dubbing"] {
        let core = crate::mix::tests::core(&root, p.clone());
        let app = tauri::test::mock_app();
        let key = enqueue(core.clone(), app.handle().clone(), options(id, "track")).unwrap();
        let job = finish(&core, &key).await;
        assert_eq!(job.status, "succeeded", "{:?} {:?}", id, job.error);
        let next = core
            .session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .project
            .clone();
        next.validate().unwrap();
        assert_eq!(next.format_version, 18);
        let new = next.tracks.last().unwrap();
        assert_eq!(new.name.as_deref(), Some("Piste traitée · FX"));
        assert!(!new.mute);
        assert!(next.tracks.iter().find(|t| t.id == id).unwrap().mute);
        let old = mix::tracks(&p).into_iter().find(|t| t.id == id).unwrap();
        assert_eq!(new.gain, old.gain);
        assert_eq!(
            serde_json::to_value(&new.regions).unwrap(),
            serde_json::to_value(&old.regions).unwrap()
        );
        assert_eq!(
            crate::audio_files::wav_frames(
                &project::asset(&root, new.path.as_deref().unwrap()).unwrap()
            )
            .unwrap(),
            192000
        );
        assert_eq!(
            std::fs::read(root.join("media/source.mkv")).unwrap(),
            original
        );
        assert_eq!(std::fs::read(root.join("stems/music.wav")).unwrap(), music);
        assert_eq!(
            std::fs::read(root.join("generations/voice.wav")).unwrap(),
            voice
        );
    }
}
#[tokio::test]
async fn selection_becomes_ordered_replace_layer_without_baking_volume_twice() {
    let (_dir, root, mut p) = crate::mix::tests::fixture().await;
    p.tracks
        .iter_mut()
        .find(|t| t.id == "music")
        .unwrap()
        .regions = serde_json::from_value(
        serde_json::json!([{"id":"gain","startMs":0,"endMs":4000,"gain":0.5,"mute":false}]),
    )
    .unwrap();
    let core = crate::mix::tests::core(&root, p.clone());
    let app = tauri::test::mock_app();
    let mut o = options("music", "selection");
    o.start_ms = 500;
    o.end_ms = 1500;
    let key = enqueue(core.clone(), app.handle().clone(), o).unwrap();
    let job = finish(&core, &key).await;
    assert_eq!(job.status, "succeeded", "{:?}", job.error);
    let next = core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .clone();
    let patches = crate::audio_patch::all(&next).unwrap();
    assert_eq!(patches.len(), 1);
    assert_eq!(patches[0].operation, "effects");
    assert_eq!(patches[0].mode, "replace");
    assert_eq!(patches[0].start_ms, 500);
    assert_eq!(patches[0].end_ms, 1500);
    assert_eq!(
        serde_json::to_value(&next.tracks).unwrap(),
        serde_json::to_value(&p.tracks).unwrap()
    );
    let path = project::asset(&root, patches[0].path.as_deref().unwrap()).unwrap();
    let bytes = std::fs::read(path).unwrap();
    assert!(bytes
        .windows(2)
        .any(|p| i16::from_le_bytes([p[0], p[1]]).unsigned_abs() > 3000));
    let output = root.join("cache/mixed.wav");
    crate::audio_patch::snippet(
        &core,
        app.handle(),
        &key,
        &next,
        &root,
        crate::audio_patch::Snippet {
            track_id: "music",
            start_ms: 0,
            end_ms: 4000,
            channels: 2,
            rate: 48000,
            fader: true,
        },
        &output,
        &AtomicBool::new(false),
    )
    .await
    .unwrap();
    let decoded = media::command(&crate::mix::tests::tool("ffmpeg"))
        .args(["-v", "error", "-i"])
        .arg(output)
        .args(["-f", "f32le", "-"])
        .output()
        .await
        .unwrap();
    assert!(decoded.status.success());
    let samples: Vec<f32> = decoded
        .stdout
        .as_chunks::<4>().0.iter()
        .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
        .collect();
    for time in [200, 900, 2000] {
        let at = time * 96;
        let level = samples[at..at + 960].iter().sum::<f32>() / 960.0;
        assert!(
            (level - 0.025 * std::f32::consts::FRAC_1_SQRT_2).abs() < 0.001,
            "{time}: {level}"
        );
    }
}
#[tokio::test]
async fn cancellation_and_stale_commit_leave_project_and_original_files_unchanged() {
    let (_dir, root, p) = crate::mix::tests::fixture().await;
    let core = crate::mix::tests::core(&root, p.clone());
    let app = tauri::test::mock_app();
    let key = jobs::create(&core, app.handle(), "audioEffects", p.id.clone(), None);
    let mut r = Request {
        root: root.clone(),
        project_id: p.id.clone(),
        revision: p.revision,
        options: options("music", "track"),
    };
    let cancelled = Arc::new(AtomicBool::new(true));
    assert_eq!(
        execute(&core, app.handle(), &key, &r, &p, &cancelled)
            .await
            .unwrap_err(),
        "CANCELLED"
    );
    r.revision += 1;
    assert_eq!(
        execute(
            &core,
            app.handle(),
            &key,
            &r,
            &p,
            &Arc::new(AtomicBool::new(false))
        )
        .await
        .unwrap_err(),
        "STALE_REVISION"
    );
    assert_eq!(
        core.session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .project
            .revision,
        p.revision
    );
    assert!(!std::fs::read_dir(root.join("stems"))
        .unwrap()
        .any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("patch-")));
}
#[tokio::test]
async fn invalid_ranges_chains_and_riff_overflow_are_rejected_before_processing() {
    let (_dir, _root, mut p) = crate::mix::tests::fixture().await;
    let mut o = options("music", "selection");
    o.end_ms = 0;
    assert!(validate(&p, &o).is_err());
    o = options("music", "track");
    o.effects.clear();
    assert!(validate(&p, &o).is_err());
    o = options("dubbing", "selection");
    assert_eq!(
        validate(&p, &o).unwrap_err(),
        "AUDIO_EFFECTS_SELECTION_LIMIT"
    );
    p.media.as_mut().unwrap().info.duration_ms = 86_400_000;
    o = options("music", "track");
    o.end_ms = 86_400_000;
    assert_eq!(validate(&p, &o).unwrap_err(), "AUDIO_EFFECTS_TOO_LONG");
    o = options("music", "selection");
    o.end_ms = 120_001;
    assert_eq!(
        validate(&p, &o).unwrap_err(),
        "AUDIO_EFFECTS_SELECTION_LIMIT"
    );
}
#[tokio::test]
async fn repeat_effect_edits_reuse_dry_baseline_and_clear_without_stacking_or_destroying_undo_assets(
) {
    let (_dir, root, p) = crate::mix::tests::fixture().await;
    for scope in ["track", "selection"] {
        let core = crate::mix::tests::core(&root, p.clone());
        let app = tauri::test::mock_app();
        let mut o = options("music", scope);
        o.effects = vec![serde_json::from_value(
            serde_json::json!({"kind":"pitch","enabled":true,"parameters":{"semitones":4}}),
        )
        .unwrap()];
        let key = enqueue(core.clone(), app.handle().clone(), o.clone()).unwrap();
        assert_eq!(finish(&core, &key).await.status, "succeeded");
        let first = core
            .session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .project
            .clone();
        let record = first.generations.last().unwrap();
        let baseline = record["effectsSourcePath"].as_str().unwrap().to_owned();
        let first_output = record["path"].as_str().unwrap().to_owned();
        if scope == "track" {
            o.track_id = record["trackId"].as_str().unwrap().into();
        }
        let original_dry = std::fs::read(root.join(&baseline)).unwrap();
        o.effects.clear();
        let key = enqueue(core.clone(), app.handle().clone(), o).unwrap();
        assert_eq!(finish(&core, &key).await.status, "succeeded");
        let next = core
            .session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .project
            .clone();
        next.validate().unwrap();
        assert_eq!(next.tracks.len(), first.tracks.len());
        assert_eq!(next.generations.len(), first.generations.len());
        let updated = next.generations.last().unwrap();
        assert_eq!(updated["effectsSourcePath"], baseline);
        assert!(updated["effects"].as_array().unwrap().is_empty());
        assert_ne!(updated["path"], first_output);
        assert_eq!(std::fs::read(root.join(baseline)).unwrap(), original_dry);
        assert!(root.join(first_output).is_file());
        let restored = project::asset(&root, updated["path"].as_str().unwrap()).unwrap();
        assert_eq!(
            crate::audio_files::wav_frames(&restored).unwrap(),
            if scope == "track" { 192000 } else { 48000 }
        );
    }
}
