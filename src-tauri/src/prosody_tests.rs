use super::*;
use std::f64::consts::PI;
fn options() -> Options {
    Options {
        generation_id: "base".into(),
        reference_mode: "dialogue".into(),
        reference_id: None,
        character_id: None,
        reference_track_id: None,
        strength: 0.7,
        pitch: true,
        rhythm: true,
        energy: true,
    }
}
fn fixture(path: &Path, guide: bool) {
    let mut phase = 0.0;
    let samples: Vec<f64> = (0..48000)
        .map(|i| {
            let t = i as f64 / 24000.0;
            let f = if guide {
                160.0 * 2.0_f64.powf((t - 1.0) * 5.0 / 12.0)
            } else {
                180.0
            };
            phase += 2.0 * PI * f / 24000.0;
            let envelope = if guide {
                0.15 + 0.15 * (2.0 * PI * t * 1.4).sin().abs()
            } else {
                0.3
            };
            envelope * (0.8 * phase.sin() + 0.2 * (2.0 * phase).sin())
        })
        .collect();
    signal::write_pcm(path, &samples).unwrap();
}
fn executable() -> Option<PathBuf> {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("praat{}", std::env::consts::EXE_SUFFIX));
    if !p.exists() {
        eprintln!("Praat executable unavailable: this native diagnostic runs in Windows CI after prepare-prosody.ps1.");
        return None;
    }
    Some(p)
}
#[test]
fn settings_analysis_and_future_metadata_are_rejected_before_render() {
    let mut o = options();
    assert!(o.validate().is_ok());
    for bad in [f64::NAN, f64::INFINITY, -0.1, 1.1] {
        o.strength = bad;
        assert!(o.validate().is_err());
    }
    assert!(signal::parse("time,pitch,rms\n0,180,0.1\n0.01,NaN,0.1\n0.02,180,0.1").is_err());
    assert!(signal::parse("time,pitch,rms\n0,180,0.1\n0.01,180,0.1\n0.005,180,0.1").is_err());
    let p = Project::new("test".into(), "ja".into(), "fr".into());
    let request = Request {
        root: PathBuf::new(),
        project_id: p.id.clone(),
        revision: p.revision + 1,
        options: options(),
    };
    assert_eq!(check(&p, &request).unwrap_err(), "STALE_REVISION");
}
#[test]
fn actual_praat_transfer_preserves_originals_tail_and_bounded_duration() {
    let Some(executable) = executable() else {
        return;
    };
    tauri::async_runtime::block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base.wav");
        let guide = dir.path().join("guide.wav");
        let out = dir.path().join("output.wav");
        fixture(&base, false);
        fixture(&guide, true);
        let originals = (
            std::fs::read(&base).unwrap(),
            std::fs::read(&guide).unwrap(),
        );
        process(
            &executable,
            &base,
            &guide,
            &out,
            &options(),
            &AtomicBool::new(false),
            |_, _| {},
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&base).unwrap(), originals.0);
        assert_eq!(std::fs::read(&guide).unwrap(), originals.1);
        let samples = signal::read_pcm(&out).unwrap();
        assert!((38400..=60000).contains(&samples.len()));
        assert!(samples.iter().all(|s| s.is_finite() && s.abs() <= 0.981));
        assert!(
            samples[samples.len() - 1200..]
                .iter()
                .map(|s| s * s)
                .sum::<f64>()
                / 1200.0
                > 0.001,
            "last syllable must remain audible"
        );
        let analysis = dir.path().join("result.csv");
        praat(
            &executable,
            &dir.path().join("analyze.praat"),
            &[&out, &analysis],
            &AtomicBool::new(false),
        )
        .await
        .unwrap();
        let frames = signal::parse(&std::fs::read_to_string(analysis).unwrap()).unwrap();
        let early: Vec<_> = frames
            .iter()
            .filter(|f| f.time > 0.3 && f.time < 0.6 && f.pitch > 0.0)
            .collect();
        let late: Vec<_> = frames
            .iter()
            .filter(|f| f.time > 1.4 && f.time < 1.7 && f.pitch > 0.0)
            .collect();
        let first = early.iter().map(|f| f.pitch).sum::<f64>() / early.len() as f64;
        let last = late.iter().map(|f| f.pitch).sum::<f64>() / late.len() as f64;
        assert!(
            last > first * 1.08,
            "rising guide must change output melody: {first} -> {last}"
        );
        assert!(
            (140.0..230.0).contains(&first) && (140.0..230.0).contains(&last),
            "source vocal register must remain bounded"
        );
    });
}
#[test]
fn zero_strength_is_bit_exact_and_cancellation_does_not_write_a_take() {
    let Some(executable) = executable() else {
        return;
    };
    tauri::async_runtime::block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base.wav");
        let guide = dir.path().join("guide.wav");
        let out = dir.path().join("copy.wav");
        fixture(&base, false);
        fixture(&guide, true);
        let mut o = options();
        o.strength = 0.0;
        process(
            &executable,
            &base,
            &guide,
            &out,
            &o,
            &AtomicBool::new(false),
            |_, _| {},
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&base).unwrap(), std::fs::read(&out).unwrap());
        let cancelled = dir.path().join("cancelled.wav");
        assert_eq!(
            process(
                &executable,
                &base,
                &guide,
                &cancelled,
                &o,
                &AtomicBool::new(true),
                |_, _| {}
            )
            .await
            .unwrap_err(),
            "CANCELLED"
        );
        assert!(!cancelled.exists());
    });
}
#[test]
fn silent_guides_fail_without_a_partial_take() {
    let Some(executable) = executable() else {
        return;
    };
    tauri::async_runtime::block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("base.wav");
        let guide = dir.path().join("guide.wav");
        let out = dir.path().join("bad.wav");
        fixture(&base, false);
        signal::write_pcm(&guide, &vec![0.0; 24000]).unwrap();
        assert_eq!(
            process(
                &executable,
                &base,
                &guide,
                &out,
                &options(),
                &AtomicBool::new(false),
                |_, _| {}
            )
            .await
            .unwrap_err(),
            "PROSODY_NO_VOICE"
        );
        assert!(!out.exists());
    });
}
