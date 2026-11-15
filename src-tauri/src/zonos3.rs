//! Official raw-space French direction, applied without adding spoken instructions.
use crate::{domain::io_error, jobs, project, separation, Core};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
};

fn decode(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if bytes.len() < 10 || &bytes[..8] != b"\x93NUMPY\x01\x00" {
        return Err("TTS_ACCENT_EMBEDDING_FAILED".into());
    }
    let offset = 10 + u16::from_le_bytes([bytes[8], bytes[9]]) as usize;
    if bytes.len() != offset + 192 * 4 {
        return Err("TTS_ACCENT_EMBEDDING_FAILED".into());
    }
    let header = std::str::from_utf8(&bytes[10..offset]).map_err(io_error)?;
    if !header.contains("'<f4'")
        || !header.contains("False")
        || !(header.contains("(192,)") || header.contains("(1, 192)"))
    {
        return Err("TTS_ACCENT_EMBEDDING_FAILED".into());
    }
    let values: Vec<_> = bytes[offset..]
        .chunks_exact(4)
        .map(|s| f32::from_le_bytes(s.try_into().unwrap()))
        .collect();
    if values.iter().any(|v| !v.is_finite())
        || values.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>() < 1e-12
    {
        return Err("TTS_ACCENT_EMBEDDING_FAILED".into());
    }
    Ok(values)
}
fn shift(bytes: &[u8], dose: f64) -> Result<Vec<u8>, String> {
    if !dose.is_finite() || !(0.0..=1.5).contains(&dose) {
        return Err("INVALID_TTS_QUALITY".into());
    }
    let base = decode(bytes)?;
    if dose == 0.0 {
        return Ok(bytes.to_vec());
    }
    let catalog: serde_json::Value =
        serde_json::from_str(include_str!("../../workers/zonos3-accent.json")).map_err(io_error)?;
    let direction = catalog["vector"]
        .as_array()
        .ok_or("TTS_ACCENT_EMBEDDING_FAILED")?;
    if direction.len() != 192 {
        return Err("TTS_ACCENT_EMBEDDING_FAILED".into());
    }
    let moved: Vec<f64> = base
        .iter()
        .zip(direction)
        .map(|(b, d)| Ok(f64::from(*b) + dose * d.as_f64().ok_or("TTS_ACCENT_EMBEDDING_FAILED")?))
        .collect::<Result<_, String>>()?;
    let norm = |v: &[f64]| v.iter().map(|x| x * x).sum::<f64>().sqrt();
    let scale =
        norm(&base.iter().map(|v| f64::from(*v)).collect::<Vec<_>>()) / norm(&moved).max(1e-8);
    let mut out = bytes[..bytes.len() - 192 * 4].to_vec();
    for v in moved {
        let v = (v * scale) as f32;
        if !v.is_finite() {
            return Err("TTS_ACCENT_EMBEDDING_FAILED".into());
        }
        out.extend(v.to_le_bytes());
    }
    decode(&out)?;
    Ok(out)
}
pub(crate) fn strength(input: &serde_json::Value) -> Result<f64, String> {
    let value = input["quality"]["accentStrength"].as_f64().unwrap_or(1.0);
    if !value.is_finite() || !(0.0..=1.5).contains(&value) {
        return Err("INVALID_TTS_QUALITY".into());
    }
    Ok(value)
}
pub(crate) async fn reference<R: tauri::Runtime>(
    core: &Arc<Core>,
    app: &tauri::AppHandle<R>,
    key: &str,
    input: &serde_json::Value,
    model: &Path,
    executable: &Path,
    flag: &AtomicBool,
) -> Result<Option<PathBuf>, String> {
    if input["variantId"] != "zonos3-mini-gguf"
        || input["accent"].as_str().unwrap_or("auto") == "auto"
    {
        return Ok(None);
    }
    if input["accent"] != "fr-FR" || input["language"] != "fr" {
        return Err("TTS_ACCENT_UNSUPPORTED".into());
    }
    let dose = strength(input)?;
    if dose == 0.0 {
        return Ok(None);
    }
    let original = Path::new(
        input["referenceAudio"]
            .as_str()
            .ok_or("TTS_REFERENCE_REQUIRED")?,
    );
    let bytes = tokio::fs::read(original).await.map_err(io_error)?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("INVALID_REFERENCE_AUDIO".into());
    }
    let mut hash = Sha256::new();
    hash.update(b"zonos3-mini-d2d142a-mect-b2-embedding-v1");
    hash.update(&bytes);
    let id = format!("{:x}", hash.finalize());
    let output = Path::new(input["outputPath"].as_str().ok_or("INVALID_PATH")?);
    let root = output
        .parent()
        .and_then(Path::parent)
        .ok_or("INVALID_PATH")?;
    let cache = project::ensure_directory(root, "cache")?;
    let parent = project::ensure_directory(&cache, "zonos3-voice")?;
    let embedding = parent.join(format!("{id}.npy"));
    if std::fs::read(&embedding)
        .ok()
        .is_none_or(|v| decode(&v).is_err())
    {
        jobs::update(core, app, key, |j| {
            j.stage = "ttsReference".into();
            j.logs.push("ZONOS3: encoding the reference with MECT-B2 on CPU; the selected synthesis GPU remains unchanged.".into());
        });
        let temp = tempfile::tempdir_in(&parent).map_err(io_error)?;
        separation::process(
            core,
            app,
            key,
            executable,
            &[
                "--task".into(),
                "clon".into(),
                "--family".into(),
                "zonos3".into(),
                "--model".into(),
                model.to_string_lossy().into_owned(),
                "--backend".into(),
                "cpu".into(),
                "--threads".into(),
                "6".into(),
                "--voice-ref".into(),
                original.to_string_lossy().into_owned(),
                "--request-option".into(),
                "encode_reference_only=true".into(),
                "--out-dir".into(),
                temp.path().to_string_lossy().into_owned(),
            ],
            flag,
        )
        .await?;
        let encoded =
            std::fs::read(temp.path().join("zonos3_speaker_embedding.npy")).map_err(io_error)?;
        decode(&encoded)?;
        project::atomic_write(&embedding, &encoded)?;
    }
    let transformed = parent.join(format!("{id}-fr-{:016x}.npy", dose.to_bits()));
    let original = std::fs::read(&embedding).map_err(io_error)?;
    let shifted = shift(&original, dose)?;
    project::atomic_write(&transformed, &shifted)?;
    jobs::update(core, app, key, |j| {
        j.logs.push(format!("ZONOS3: official French speaker-embedding direction, strength {dose:.2}; original norm retained. No accent text is prepended. Regional accent and unchanged identity are not guaranteed."))
    });
    Ok(Some(transformed))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Vec<u8> {
        let mut header = "{'descr': '<f4', 'fortran_order': False, 'shape': (192,), }".to_owned();
        while (10 + header.len() + 1) % 64 != 0 {
            header.push(' ');
        }
        header.push('\n');
        let mut bytes = b"\x93NUMPY\x01\x00".to_vec();
        bytes.extend((header.len() as u16).to_le_bytes());
        bytes.extend(header.as_bytes());
        for n in 0..192 {
            bytes.extend((0.1 + (n as f32) / 1000.0).to_le_bytes());
        }
        bytes
    }
    #[test]
    fn official_accent_shift_is_bounded_norm_preserving_and_zero_is_bit_exact() {
        let base = fixture();
        assert_eq!(shift(&base, 0.0).unwrap(), base);
        let output = shift(&base, 0.75).unwrap();
        assert_ne!(output, base);
        let norm = |v: &[f32]| v.iter().map(|x| f64::from(*x).powi(2)).sum::<f64>().sqrt();
        assert!((norm(&decode(&base).unwrap()) - norm(&decode(&output).unwrap())).abs() < 1e-6);
        for value in [-1.0, 1.51, f64::NAN, f64::INFINITY] {
            assert!(shift(&base, value).is_err());
        }
        assert!(decode(&base[..base.len() - 4]).is_err());
    }
}
