use super::*;
use crate::{audio_files, voice_edit};
use std::{path::Path, sync::atomic::AtomicBool};

fn effect(kind: &str) -> Effect {
    let spec = catalog()["effects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == kind)
        .unwrap();
    Effect {
        kind: kind.into(),
        enabled: true,
        parameters: spec["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                (
                    p["id"].as_str().unwrap().into(),
                    p["default"].as_f64().unwrap(),
                )
            })
            .collect(),
    }
}
fn tone(path: &Path) {
    let count = 36000u32;
    let mut bytes = vec![];
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(count * 2 + 36).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&24000u32.to_le_bytes());
    bytes.extend_from_slice(&48000u32.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&(count * 2).to_le_bytes());
    for i in 0..count {
        bytes.extend_from_slice(
            &((f64::from(i) * 440.0 * std::f64::consts::TAU / 24000.0)
                .sin()
                .mul_add(7000.0, 0.0) as i16)
                .to_le_bytes(),
        );
    }
    std::fs::write(path, bytes).unwrap();
}
fn samples(path: &Path) -> Vec<i16> {
    let bytes = std::fs::read(path).unwrap();
    let mut at = 12;
    while &bytes[at..at + 4] != b"data" {
        let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
        at += 8 + size + size % 2;
    }
    let len = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
    bytes[at + 8..at + 8 + len]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| i16::from_le_bytes(b.try_into().unwrap()))
        .collect()
}
#[test]
fn catalog_presets_and_bounds_reject_untrusted_or_excessive_filters() {
    assert_eq!(catalog()["effects"].as_array().unwrap().len(), 20);
    for p in catalog()["presets"].as_array().unwrap() {
        let chain: Vec<Effect> = serde_json::from_value(p["chain"].clone()).unwrap();
        validate(&chain).unwrap();
        assert!(!filter_chain(&chain).unwrap().is_empty());
    }
    let mut e = effect("pitch");
    e.parameters.insert("semitones".into(), 12.1);
    assert!(validate(&[e]).is_err());
    let mut e = effect("equalizer");
    e.parameters.insert("filter;amovie".into(), 1.0);
    assert!(validate(&[e]).is_err());
    let mut e = effect("pitch");
    e.parameters.insert("semitones".into(), f64::NAN);
    assert!(validate(&[e]).is_err());
    assert!(validate(&vec![effect("echo"); 9]).is_err());
    let mut e = effect("echo");
    e.kind = "amovie".into();
    assert!(validate(&[e]).is_err());
    let mut e = effect("echo");
    e.enabled = false;
    assert!(filter_chain(&[e]).unwrap().is_empty());
}
#[tokio::test]
async fn all_twenty_effects_render_exact_duration_without_touching_source() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("tone.wav");
    tone(&source);
    let original = std::fs::read(&source).unwrap();
    for spec in catalog()["effects"].as_array().unwrap() {
        let e = effect(spec["id"].as_str().unwrap());
        let edit = voice_edit::Edit {
            pieces: vec![voice_edit::Piece {
                effects: vec![e.clone()],
                source_start_ms: Some(0),
                source_end_ms: Some(1500),
                duration_ms: 1500,
                gain: 1.0,
                envelope: None,
            }],
        };
        let result = voice_edit::render(
            dir.path(),
            "tone.wav",
            Some(&edit),
            &crate::mix::tests::tool("ffmpeg"),
            &AtomicBool::new(false),
        )
        .await;
        assert!(result.is_ok(), "{}: {:?}", e.kind, result);
        let path = result.unwrap();
        assert_eq!(
            audio_files::pcm_frames(&path, 1, 24000, "bad").unwrap(),
            36000
        );
        assert!(
            samples(&path).iter().any(|s| s.abs() > 2),
            "{} returned silence",
            e.kind
        );
    }
    assert_eq!(std::fs::read(&source).unwrap(), original);
}
#[tokio::test]
async fn pitch_changes_frequency_only_inside_selection_and_muted_pieces_stay_silent() {
    let dir = tempfile::tempdir().unwrap();
    tone(&dir.path().join("tone.wav"));
    let mut pitch = effect("pitch");
    pitch.parameters.insert("semitones".into(), 12.0);
    let mut edit = voice_edit::Edit {
        pieces: vec![
            voice_edit::Piece {
                effects: vec![pitch],
                source_start_ms: Some(0),
                source_end_ms: Some(750),
                duration_ms: 750,
                gain: 1.0,
                envelope: None,
            },
            voice_edit::Piece {
                effects: vec![],
                source_start_ms: Some(750),
                source_end_ms: Some(1500),
                duration_ms: 750,
                gain: 1.0,
                envelope: None,
            },
        ],
    };
    let path = voice_edit::render(
        dir.path(),
        "tone.wav",
        Some(&edit),
        &crate::mix::tests::tool("ffmpeg"),
        &AtomicBool::new(false),
    )
    .await
    .unwrap();
    let wave = samples(&path);
    let frequency = |start: usize| {
        wave[start..start + 9600]
            .windows(2)
            .filter(|p| p[0] <= 0 && p[1] > 0)
            .count() as f64
            / 0.4
    };
    assert!((frequency(4800) - 880.0).abs() < 8.0);
    assert!((frequency(24000) - 440.0).abs() < 8.0);
    assert_eq!(wave.len(), 36000);
    edit.pieces[0].gain = 0.0;
    let muted = voice_edit::render(
        dir.path(),
        "tone.wav",
        Some(&edit),
        &crate::mix::tests::tool("ffmpeg"),
        &AtomicBool::new(false),
    )
    .await
    .unwrap();
    assert!(samples(&muted)[..12000].iter().all(|s| *s == 0));
}
