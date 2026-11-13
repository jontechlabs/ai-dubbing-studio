//! Linked-stereo RMS levelling. No synthesis, time stretch or silence removal.
use crate::{domain::io_error, project};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
const RATE: usize = 48_000;
const WINDOW: usize = RATE / 2;
const CEILING: f64 = 0.98;
const MAX_GAIN: f64 = 8.0;

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub target_db: f64,
    pub quiet_db: f64,
    pub loud_db: f64,
    pub safety_db: f64,
    pub gain_limited: bool,
    pub active_windows: usize,
}
pub fn read(path: &Path, frames: u64) -> Result<Vec<i16>, String> {
    if frames == 0 || frames > 120_000 * 48 || crate::audio_files::wav_frames(path)? != frames {
        return Err("VOLUME_LEVELING_INVALID_AUDIO".into());
    }
    let mut file = std::fs::File::open(path).map_err(io_error)?;
    file.seek(SeekFrom::Start(12)).map_err(io_error)?;
    loop {
        let mut chunk = [0_u8; 8];
        file.read_exact(&mut chunk).map_err(io_error)?;
        let size = u32::from_le_bytes(chunk[4..].try_into().unwrap());
        if &chunk[..4] == b"data" {
            if u64::from(size) != frames * 4 {
                return Err("VOLUME_LEVELING_INVALID_AUDIO".into());
            }
            let mut bytes = vec![0; size as usize];
            file.read_exact(&mut bytes).map_err(io_error)?;
            return Ok(bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|v| i16::from_le_bytes([v[0], v[1]]))
                .collect());
        }
        file.seek(SeekFrom::Current(i64::from(size) + i64::from(size % 2)))
            .map_err(io_error)?;
    }
}
pub fn write(path: &Path, samples: &[i16]) -> Result<(), String> {
    let size = u32::try_from(samples.len() * 2).map_err(io_error)?;
    let mut bytes = Vec::with_capacity(44 + size as usize);
    bytes.extend(b"RIFF");
    bytes.extend((36 + size).to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(16_u32.to_le_bytes());
    bytes.extend(1_u16.to_le_bytes());
    bytes.extend(2_u16.to_le_bytes());
    bytes.extend(48_000_u32.to_le_bytes());
    bytes.extend(192_000_u32.to_le_bytes());
    bytes.extend(4_u16.to_le_bytes());
    bytes.extend(16_u16.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend(size.to_le_bytes());
    for sample in samples {
        bytes.extend(sample.to_le_bytes());
    }
    project::atomic_write(path, &bytes)
}
pub fn process(
    samples: &[i16],
    mode: &str,
    cancel: &AtomicBool,
) -> Result<(Vec<i16>, Stats), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    if !["low", "high"].contains(&mode)
        || samples.is_empty()
        || !samples.len().is_multiple_of(2)
        || samples.len() > 120_000 * 96
    {
        return Err("VOLUME_LEVELING_OPTIONS".into());
    }
    let rms: Vec<f64> = samples
        .chunks(WINDOW * 2)
        .map(|block| {
            (block
                .iter()
                .map(|v| (f64::from(*v) / 32768.0).powi(2))
                .sum::<f64>()
                / block.len() as f64)
                .sqrt()
        })
        .collect();
    let loud = rms.iter().copied().fold(0.0, f64::max);
    // Reject pure noise-floor/silent material; never use silence as a target.
    let threshold = (loud * 0.0316227766).max(0.001);
    let active: Vec<_> = rms.iter().copied().filter(|r| *r >= threshold).collect();
    let quiet = active
        .iter()
        .copied()
        .reduce(f64::min)
        .ok_or("VOLUME_LEVELING_SILENT")?;
    let target = if mode == "low" { quiet } else { loud };
    let mut limited = false;
    let gains: Vec<f64> = rms
        .iter()
        .map(|r| {
            if *r < threshold {
                return 1.0;
            }
            let gain = target / r;
            limited |= gain > MAX_GAIN;
            gain.min(MAX_GAIN)
        })
        .collect();
    let frames = samples.len() / 2;
    let gain_at = |frame: usize| {
        let position = frame as f64 / WINDOW as f64 - 0.5;
        let left = position.floor().max(0.0) as usize;
        let right = (position.floor() + 1.0).max(0.0) as usize;
        let fraction = position - position.floor();
        let a = gains[left.min(gains.len() - 1)].ln();
        let b = gains[right.min(gains.len() - 1)].ln();
        let smooth = (a + (b - a) * fraction).exp();
        // Join the unchanged adjacent audio without a hard gain jump.
        let edge = (frame.min(frames - 1 - frame) as f64 / 480.0).min(1.0);
        1.0 + (smooth - 1.0) * edge
    };
    let mut peak: f64 = 0.0;
    for (i, frame) in samples.as_chunks::<2>().0.iter().enumerate() {
        if i.is_multiple_of(RATE) && cancel.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        let gain = gain_at(i);
        peak = peak.max(f64::from(frame[0]).abs().max(f64::from(frame[1]).abs()) / 32768.0 * gain);
    }
    // One common safety attenuation preserves the waveform and stereo image.
    let safety = if peak > CEILING { CEILING / peak } else { 1.0 };
    let mut output = Vec::with_capacity(samples.len());
    for (i, frame) in samples.as_chunks::<2>().0.iter().enumerate() {
        if i.is_multiple_of(RATE) && cancel.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        let gain = gain_at(i) * safety;
        output.extend(
            frame
                .iter()
                .map(|s| (f64::from(*s) * gain).round().clamp(-32768.0, 32767.0) as i16),
        );
    }
    Ok((
        output,
        Stats {
            target_db: 20.0 * (target * safety).log10(),
            quiet_db: 20.0 * quiet.log10(),
            loud_db: 20.0 * loud.log10(),
            safety_db: 20.0 * safety.log10(),
            gain_limited: limited,
            active_windows: active.len(),
        },
    ))
}
