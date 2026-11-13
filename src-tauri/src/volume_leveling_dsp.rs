//! Linked-stereo RMS levelling in three bounded-memory passes over PCM.
//! Only half-second statistics and one PCM window are retained, including on long tracks.
use crate::domain::io_error;
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
const RATE: usize = 48_000;
const WINDOW: usize = RATE / 2;
const CEILING: f64 = 0.98;
const MAX_GAIN: f64 = 8.0;
pub const MAX_MS: u64 = 86_400_000;

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
pub struct Pcm {
    file: BufReader<File>,
    offset: u64,
    pub frames: u64,
}
impl Pcm {
    pub fn open(path: &Path) -> Result<Self, String> {
        let frames = crate::audio_files::wav_frames(path)?;
        if frames == 0 || frames > MAX_MS * 48 {
            return Err("VOLUME_LEVELING_INVALID_AUDIO".into());
        }
        let mut file = BufReader::new(File::open(path).map_err(io_error)?);
        file.seek(SeekFrom::Start(12)).map_err(io_error)?;
        loop {
            let mut chunk = [0_u8; 8];
            file.read_exact(&mut chunk).map_err(io_error)?;
            if &chunk[..4] == b"data" {
                let offset = file.stream_position().map_err(io_error)?;
                return Ok(Self {
                    file,
                    offset,
                    frames,
                });
            }
            let size = u32::from_le_bytes(chunk[4..].try_into().unwrap());
            file.seek(SeekFrom::Current(i64::from(size) + i64::from(size % 2)))
                .map_err(io_error)?;
        }
    }
    fn rewind(&mut self) -> Result<(), String> {
        self.file
            .seek(SeekFrom::Start(self.offset))
            .map_err(io_error)?;
        Ok(())
    }
}
// RF64 is required beyond the RIFF 4 GiB payload limit. Small chunks remain ordinary WAV.
pub(crate) fn header(mut out: impl Write, frames: u64) -> Result<(), String> {
    let size = frames
        .checked_mul(4)
        .ok_or("VOLUME_LEVELING_INVALID_AUDIO")?;
    let large = size > u64::from(u32::MAX) - 36;
    out.write_all(if large { b"RF64" } else { b"RIFF" })
        .map_err(io_error)?;
    out.write_all(&(if large { u32::MAX } else { (36 + size) as u32 }).to_le_bytes())
        .map_err(io_error)?;
    out.write_all(b"WAVE").map_err(io_error)?;
    if large {
        out.write_all(b"ds64").map_err(io_error)?;
        out.write_all(&28_u32.to_le_bytes()).map_err(io_error)?;
        out.write_all(&(size + 72).to_le_bytes())
            .map_err(io_error)?;
        out.write_all(&size.to_le_bytes()).map_err(io_error)?;
        out.write_all(&frames.to_le_bytes()).map_err(io_error)?;
        out.write_all(&0_u32.to_le_bytes()).map_err(io_error)?;
    }
    out.write_all(b"fmt ").map_err(io_error)?;
    out.write_all(&16_u32.to_le_bytes()).map_err(io_error)?;
    for bytes in [1_u16.to_le_bytes(), 2_u16.to_le_bytes()] {
        out.write_all(&bytes).map_err(io_error)?;
    }
    out.write_all(&48_000_u32.to_le_bytes()).map_err(io_error)?;
    out.write_all(&192_000_u32.to_le_bytes())
        .map_err(io_error)?;
    out.write_all(&4_u16.to_le_bytes()).map_err(io_error)?;
    out.write_all(&16_u16.to_le_bytes()).map_err(io_error)?;
    out.write_all(b"data").map_err(io_error)?;
    out.write_all(&(if large { u32::MAX } else { size as u32 }).to_le_bytes())
        .map_err(io_error)?;
    Ok(())
}
pub fn copy_range(input: &Path, output: &Path, start_ms: u64, end_ms: u64) -> Result<(), String> {
    let mut pcm = Pcm::open(input)?;
    if end_ms <= start_ms
        || end_ms > MAX_MS
        || end_ms - start_ms > 30000
        || end_ms * 48 > pcm.frames
    {
        return Err("INVALID_AUDIO_TRANSFER".into());
    }
    pcm.file
        .seek(SeekFrom::Start(pcm.offset + start_ms * 192))
        .map_err(io_error)?;
    let mut out = BufWriter::new(File::create(output).map_err(io_error)?);
    let frames = (end_ms - start_ms) * 48;
    header(&mut out, frames)?;
    let count = std::io::copy(&mut pcm.file.take(frames * 4), &mut out).map_err(io_error)?;
    if count != frames * 4 {
        return Err("VOLUME_LEVELING_INVALID_AUDIO".into());
    }
    out.flush().map_err(io_error)?;
    Ok(())
}
fn check(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        Err("CANCELLED".into())
    } else {
        Ok(())
    }
}
fn gain_at(frame: usize, frames: usize, gains: &[f64]) -> f64 {
    let block = frame / WINDOW;
    let offset = frame % WINDOW;
    let length = WINDOW.min(frames - block * WINDOW);
    let width = 2400.min(length / 2).max(1);
    let gain = gains[block];
    let previous = gains[block.saturating_sub(1)];
    let following = gains[(block + 1).min(gains.len() - 1)];
    // Reduce before a louder window; release after a quieter one, avoiding new peaks.
    let smooth = if gain > previous && offset < width {
        (previous.ln() + (gain.ln() - previous.ln()) * offset as f64 / width as f64).exp()
    } else if gain > following && offset >= length - width {
        (gain.ln()
            + (following.ln() - gain.ln()) * (offset - (length - width)) as f64 / width as f64)
            .exp()
    } else {
        gain
    };
    let edge = (frame.min(frames - 1 - frame) as f64 / 480.0).min(1.0);
    1.0 + (smooth - 1.0) * edge
}
pub fn process_file(
    input: &Path,
    output: &Path,
    frames: u64,
    mode: &str,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f64),
) -> Result<Stats, String> {
    check(cancel)?;
    if !["low", "high"].contains(&mode) || frames == 0 || frames > MAX_MS * 48 {
        return Err("VOLUME_LEVELING_OPTIONS".into());
    }
    let mut pcm = Pcm::open(input)?;
    if pcm.frames != frames {
        return Err("VOLUME_LEVELING_INVALID_AUDIO".into());
    }
    let frames = frames as usize;
    let mut bytes = vec![0_u8; WINDOW * 4];
    let mut rms = Vec::with_capacity(frames.div_ceil(WINDOW));
    let mut last = -1.0;
    // Three passes: RMS, peak-safety analysis, rendering. Publish progress at 1% intervals.
    let mut report = |pass: usize, position: usize| {
        let value = (pass as f64 + position as f64 / frames as f64) / 3.0;
        if value - last >= 0.01 || value == 1.0 {
            progress(value);
            last = value;
        }
    };
    for position in (0..frames).step_by(WINDOW) {
        check(cancel)?;
        let count = WINDOW.min(frames - position) * 4;
        pcm.file.read_exact(&mut bytes[..count]).map_err(io_error)?;
        rms.push(
            (bytes[..count]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| (f64::from(i16::from_le_bytes(*b)) / 32768.0).powi(2))
                .sum::<f64>()
                / (count / 2) as f64)
                .sqrt(),
        );
        report(0, position + count / 4);
    }
    let loud = rms.iter().copied().fold(0.0, f64::max);
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
    pcm.rewind()?;
    let mut peak: f64 = 0.0;
    for position in (0..frames).step_by(WINDOW) {
        check(cancel)?;
        let count = WINDOW.min(frames - position) * 4;
        pcm.file.read_exact(&mut bytes[..count]).map_err(io_error)?;
        for (i, frame) in bytes[..count].as_chunks::<4>().0.iter().enumerate() {
            let left = i16::from_le_bytes(frame[..2].try_into().unwrap());
            let right = i16::from_le_bytes(frame[2..].try_into().unwrap());
            peak = peak.max(
                f64::from(left).abs().max(f64::from(right).abs()) / 32768.0
                    * gain_at(position + i, frames, &gains),
            );
        }
        report(1, position + count / 4);
    }
    let safety = if peak > CEILING { CEILING / peak } else { 1.0 };
    check(cancel)?;
    pcm.rewind()?;
    let mut out = BufWriter::new(File::create(output).map_err(io_error)?);
    header(&mut out, frames as u64)?;
    for position in (0..frames).step_by(WINDOW) {
        check(cancel)?;
        let count = WINDOW.min(frames - position) * 4;
        pcm.file.read_exact(&mut bytes[..count]).map_err(io_error)?;
        for (i, frame) in bytes[..count].as_chunks_mut::<4>().0.iter_mut().enumerate() {
            let gain = gain_at(position + i, frames, &gains) * safety;
            for sample in frame.as_chunks_mut::<2>().0 {
                let value = (f64::from(i16::from_le_bytes(*sample)) * gain)
                    .round()
                    .clamp(-32768.0, 32767.0) as i16;
                sample.copy_from_slice(&value.to_le_bytes());
            }
        }
        out.write_all(&bytes[..count]).map_err(io_error)?;
        report(2, position + count / 4);
    }
    out.flush().map_err(io_error)?;
    check(cancel)?;
    Ok(Stats {
        target_db: 20.0 * (target * safety).log10(),
        quiet_db: 20.0 * quiet.log10(),
        loud_db: 20.0 * loud.log10(),
        safety_db: 20.0 * safety.log10(),
        gain_limited: limited,
        active_windows: active.len(),
    })
}
#[cfg(test)]
pub fn read(path: &Path, frames: u64) -> Result<Vec<i16>, String> {
    let mut pcm = Pcm::open(path)?;
    if pcm.frames != frames || frames > 120000 * 48 {
        return Err("VOLUME_LEVELING_INVALID_AUDIO".into());
    }
    let mut bytes = vec![0; frames as usize * 4];
    pcm.file.read_exact(&mut bytes).map_err(io_error)?;
    Ok(bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| i16::from_le_bytes(*b))
        .collect())
}
#[cfg(test)]
pub fn write(path: &Path, samples: &[i16]) -> Result<(), String> {
    let mut out = BufWriter::new(File::create(path).map_err(io_error)?);
    header(&mut out, (samples.len() / 2) as u64)?;
    for sample in samples {
        out.write_all(&sample.to_le_bytes()).map_err(io_error)?;
    }
    out.flush().map_err(io_error)?;
    Ok(())
}
#[cfg(test)]
pub fn process(
    samples: &[i16],
    mode: &str,
    cancel: &AtomicBool,
) -> Result<(Vec<i16>, Stats), String> {
    check(cancel)?;
    if samples.is_empty() || !samples.len().is_multiple_of(2) {
        return Err("VOLUME_LEVELING_OPTIONS".into());
    }
    let dir = tempfile::tempdir().map_err(io_error)?;
    let input = dir.path().join("input.wav");
    let output = dir.path().join("output.wav");
    write(&input, samples)?;
    let frames = (samples.len() / 2) as u64;
    let stats = process_file(&input, &output, frames, mode, cancel, |_| {})?;
    Ok((read(&output, frames)?, stats))
}
