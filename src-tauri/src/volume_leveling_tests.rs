use super::*;
fn tone(amplitudes: &[f64]) -> Vec<i16> {
    let mut audio = vec![];
    for &a in amplitudes {
        for i in 0..96000 {
            let v = (a * 32767.0 * (i as f64 * std::f64::consts::TAU * 440.0 / 48000.0).sin())
                .round() as i16;
            audio.extend([v, -v]);
        }
    }
    audio
}
fn rms(data: &[i16], start: usize, end: usize) -> f64 {
    (data[start * 2..end * 2]
        .iter()
        .map(|v| f64::from(*v).powi(2))
        .sum::<f64>()
        / ((end - start) * 2) as f64)
        .sqrt()
}
#[test]
fn low_and_high_even_out_real_sample_levels_keep_silence_stereo_and_duration() {
    let input = tone(&[0.05, 0.4, 0.0]);
    let cancel = AtomicBool::new(false);
    for mode in ["low", "high"] {
        let (output, stats) = dsp::process(&input, mode, &cancel).unwrap();
        assert_eq!(output.len(), input.len());
        assert!((rms(&output, 48000, 72000) / rms(&output, 144000, 168000) - 1.0).abs() < 0.01);
        assert!(output[192000 * 2..].iter().all(|s| *s == 0));
        assert!(output.as_chunks::<2>().0.iter().all(|p| p[0] == -p[1]));
        assert!(stats.target_db.is_finite() && stats.active_windows == 8);
        // Levelling must not create an overshoot at the quiet/loud boundary.
        let original_peak = input.iter().map(|v| v.unsigned_abs()).max().unwrap();
        assert!(output.iter().all(|v| v.unsigned_abs() <= original_peak + 1));
        if mode == "low" {
            assert!(output
                .iter()
                .zip(&input)
                .all(|(a, b)| a.unsigned_abs() <= b.unsigned_abs()));
        }
    }
    let reverse = tone(&[0.4, 0.05, 0.0]);
    for mode in ["low", "high"] {
        let (audio, _) = dsp::process(&reverse, mode, &cancel).unwrap();
        assert!((rms(&audio, 48000, 72000) / rms(&audio, 144000, 168000) - 1.0).abs() < 0.01);
        let peak = reverse.iter().map(|v| v.unsigned_abs()).max().unwrap();
        assert!(audio.iter().all(|v| v.unsigned_abs() <= peak + 1));
    }
}
#[test]
fn safety_is_linked_attenuation_and_boost_is_bounded() {
    let mut input = tone(&[0.03, 0.6]);
    input[100000] = 32000;
    input[100001] = -32000;
    let (output, stats) = dsp::process(&input, "high", &AtomicBool::new(false)).unwrap();
    assert!(stats.gain_limited);
    assert!(stats.safety_db < 0.0);
    assert!(output
        .iter()
        .all(|v| f64::from(*v).abs() / 32768.0 <= 0.98004));
    assert!(output.as_chunks::<2>().0.iter().all(|p| p[0] == -p[1]));
}
#[test]
fn silence_noise_invalid_modes_and_cancel_never_create_fake_audio() {
    let cancel = AtomicBool::new(false);
    assert_eq!(
        dsp::process(&vec![0; 96000], "low", &cancel).unwrap_err(),
        "VOLUME_LEVELING_SILENT"
    );
    assert_eq!(
        dsp::process(&vec![1; 96000], "high", &cancel).unwrap_err(),
        "VOLUME_LEVELING_SILENT"
    );
    for data in [vec![], vec![1]] {
        assert!(dsp::process(&data, "low", &cancel).is_err());
    }
    assert!(dsp::process(&tone(&[0.1]), "bad", &cancel).is_err());
    assert_eq!(
        dsp::process(&tone(&[0.1]), "high", &AtomicBool::new(true)).unwrap_err(),
        "CANCELLED"
    );
}
fn options(p: &Project, track: &str) -> Options {
    Options {
        media_id: p.media.as_ref().unwrap().id.clone(),
        track_id: track.into(),
        start_ms: 1000,
        end_ms: 2000,
        mode: "low".into(),
    }
}
async fn finish(core: &Core, id: &str) -> jobs::Job {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(40);
    loop {
        let j = core.jobs.lock().unwrap()[id].snapshot();
        if !["queued", "running"].contains(&j.status.as_str()) {
            return j;
        }
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}
#[tokio::test]
async fn preview_apply_undo_and_reopen_keep_sources_and_every_take() {
    let (_dir, root, mut p) = crate::mix::tests::fixture().await;
    let music = p.tracks.iter_mut().find(|t| t.id == "music").unwrap();
    music.mute = true;
    music.gain = 0.0;
    music.regions = serde_json::from_value(
        json!([{"id":"quiet-region","startMs":0,"endMs":4000,"gain":0,"mute":true}]),
    )
    .unwrap();
    let source = std::fs::read(root.join("media/source.mkv")).unwrap();
    let original_take = std::fs::read(root.join("generations/voice.wav")).unwrap();
    for track in ["original", "music", "dubbing"] {
        let core = crate::mix::tests::core(&root, p.clone());
        let app = tauri::test::mock_app();
        let id = enqueue(
            core.clone(),
            app.handle().clone(),
            p.id.clone(),
            p.revision,
            options(&p, track),
        )
        .unwrap();
        let j = finish(&core, &id).await;
        assert_eq!(j.status, "succeeded", "{track}: {:?}", j.error);
        let before = core
            .session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .project
            .clone();
        assert_eq!(
            serde_json::to_value(&before).unwrap(),
            serde_json::to_value(&p).unwrap()
        );
        let details = result(&core, &id).unwrap();
        assert!(details["stats"]["targetDb"].as_f64().unwrap().is_finite());
        for role in ["original", "leveled"] {
            let file = path(&core, app.handle(), &id, role).unwrap();
            assert_eq!(
                crate::audio_files::wav_frames(std::path::Path::new(&file)).unwrap(),
                48000
            );
        }
        assert!(path(&core, app.handle(), &id, "../../project.json").is_err());
        let next = apply(&core, app.handle(), &id, &p.id, p.revision).unwrap();
        next.validate().unwrap();
        assert_eq!(next.format_version, 27);
        assert_eq!(next.generations.len(), p.generations.len() + 1);
        assert_eq!(
            serde_json::to_value(&next.tracks).unwrap(),
            serde_json::to_value(&p.tracks).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&next.dialogues).unwrap(),
            serde_json::to_value(&p.dialogues).unwrap()
        );
        let layer = next.generations.last().unwrap();
        let asset = root.join(layer["path"].as_str().unwrap());
        assert!(asset.is_file());
        assert!(apply(&core, app.handle(), &id, &p.id, next.revision).is_err());
        let reopened = project::load(&root).unwrap();
        assert_eq!(reopened.generations, next.generations);
        {
            let mut lock = core.session.lock().unwrap();
            let session = lock.as_mut().unwrap();
            assert_eq!(session.history(false).unwrap().generations, p.generations);
            assert!(asset.is_file());
            assert_eq!(session.history(true).unwrap().generations, next.generations);
        }
        assert_eq!(
            std::fs::read(root.join("media/source.mkv")).unwrap(),
            source
        );
        assert_eq!(
            std::fs::read(root.join("generations/voice.wav")).unwrap(),
            original_take
        );
        assert!(!folder(&request(&core, &id).unwrap(), &id).unwrap().exists());
        // A second preview reads the current replacement once, not base + layer.
        let current = core
            .session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .project
            .clone();
        let again = enqueue(
            core.clone(),
            app.handle().clone(),
            current.id.clone(),
            current.revision,
            options(&current, track),
        )
        .unwrap();
        assert_eq!(finish(&core, &again).await.status, "succeeded");
        let repeated = result(&core, &again).unwrap();
        assert!(
            (repeated["stats"]["loudDb"].as_f64().unwrap()
                - details["stats"]["loudDb"].as_f64().unwrap())
            .abs()
                < 0.05
        );
        discard(&core, &again).unwrap();
        if track == "dubbing" {
            let mut changed = current.clone();
            let mut take = changed
                .generations
                .iter()
                .find(|g| g["kind"] == "tts")
                .unwrap()
                .clone();
            take["id"] = json!("other-voice-take");
            changed.generations.push(take);
            changed.dialogues[0]
                .selected_generation_ids
                .insert("fr".into(), "other-voice-take".into());
            assert!(audio_patch::layers(&changed, "dubbing").is_empty());
            assert_eq!(audio_patch::layers(&current, "dubbing").len(), 1);
        }
    }
}
#[tokio::test]
async fn stale_and_discarded_previews_cannot_apply_and_bad_ranges_never_start() {
    let (_dir, root, p) = crate::mix::tests::fixture().await;
    let app = tauri::test::mock_app();
    let core = crate::mix::tests::core(&root, p.clone());
    for field in ["mode", "end", "start", "track", "media"] {
        let mut o = options(&p, "music");
        match field {
            "mode" => o.mode = "bad".into(),
            "end" => o.end_ms = 5000,
            "start" => o.start_ms = o.end_ms,
            "track" => o.track_id = "foreign".into(),
            _ => o.media_id = "foreign".into(),
        };
        assert!(enqueue(
            core.clone(),
            app.handle().clone(),
            p.id.clone(),
            p.revision,
            o
        )
        .is_err());
    }
    let id = enqueue(
        core.clone(),
        app.handle().clone(),
        p.id.clone(),
        p.revision,
        options(&p, "music"),
    )
    .unwrap();
    assert_eq!(finish(&core, &id).await.status, "succeeded");
    {
        let mut lock = core.session.lock().unwrap();
        let s = lock.as_mut().unwrap();
        let mut next = s.project.clone();
        next.name = "Changed".into();
        s.replace(next, p.revision).unwrap();
    }
    assert_eq!(
        apply(&core, app.handle(), &id, &p.id, p.revision).unwrap_err(),
        "STALE_REVISION"
    );
    discard(&core, &id).unwrap();
    assert!(!folder(&request(&core, &id).unwrap(), &id).unwrap().exists());
    let current = core
        .session
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .project
        .clone();
    let id = enqueue(
        core.clone(),
        app.handle().clone(),
        current.id.clone(),
        current.revision,
        options(&current, "music"),
    )
    .unwrap();
    discard(&core, &id).unwrap();
    let done = finish(&core, &id).await;
    assert_eq!(done.status, "cancelled");
    assert!(!folder(&request(&core, &id).unwrap(), &id).unwrap().exists());
    assert!(apply(&core, app.handle(), &id, &current.id, current.revision).is_err());
}
