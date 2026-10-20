//! Bounded cross-language contour transfer. French samples and consonants remain
//! the source; guide audio is never mixed into the output.
use super::Options;
use crate::domain::io_error;
use std::{
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

#[derive(Clone, Debug)]
pub struct Frame {
    pub time: f64,
    pub pitch: f64,
    pub rms: f64,
}
#[derive(Clone, Debug)]
pub struct Control {
    pub time: f64,
    pub pitch: f64,
    pub duration: f64,
    pub gain: f64,
}
pub struct Plan {
    pub points: Vec<Control>,
    pub output_times: Vec<f64>,
}

pub fn parse(text: &str) -> Result<Vec<Frame>, String> {
    let mut rows = text.lines();
    if rows.next() != Some("time,pitch,rms") {
        return Err("PROSODY_ANALYSIS_FAILED".into());
    }
    let mut frames: Vec<Frame> = vec![];
    for row in rows {
        let values: Vec<f64> = row
            .split(',')
            .map(str::parse)
            .collect::<Result<_, _>>()
            .map_err(|_| "PROSODY_ANALYSIS_FAILED")?;
        if values.len() != 3
            || values.iter().any(|v| !v.is_finite())
            || values.iter().any(|v| *v < 0.0)
            || values[1] > 1000.0
            || values[2] > 1.01
            || frames.last().is_some_and(|f| values[0] <= f.time)
            || frames.len() > 3001
        {
            return Err("PROSODY_ANALYSIS_FAILED".into());
        }
        frames.push(Frame {
            time: values[0],
            pitch: values[1],
            rms: values[2],
        });
    }
    if frames.len() < 3 || frames[0].time != 0.0 || frames.last().unwrap().time > 30.001 {
        return Err("PROSODY_ANALYSIS_FAILED".into());
    }
    Ok(frames)
}
fn median(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    Some(values[values.len() / 2])
}
fn cumulative(frames: &[Frame]) -> Vec<f64> {
    let scale = median(
        frames
            .iter()
            .filter(|f| f.rms > 0.00001)
            .map(|f| f.rms)
            .collect(),
    )
    .unwrap_or(1.0);
    let weights: Vec<f64> = frames
        .iter()
        .map(|f| (f.rms / scale).clamp(0.04, 4.0).sqrt())
        .collect();
    let mut result = vec![0.0];
    for i in 1..frames.len() {
        result.push(
            result[i - 1]
                + (weights[i - 1] + weights[i]) * 0.5 * (frames[i].time - frames[i - 1].time),
        );
    }
    let total = *result.last().unwrap();
    for v in &mut result {
        *v /= total;
    }
    result
}
fn interpolate(xs: &[f64], ys: &[f64], x: f64) -> f64 {
    let at = xs.partition_point(|v| *v < x);
    if at == 0 {
        return ys[0];
    }
    if at == xs.len() {
        return *ys.last().unwrap();
    }
    let mix = (x - xs[at - 1]) / (xs[at] - xs[at - 1]);
    ys[at - 1] + mix * (ys[at] - ys[at - 1])
}
pub fn plan(source: &[Frame], guide: &[Frame], options: &Options) -> Result<Plan, String> {
    if source.iter().all(|f| f.rms < 0.00001) || guide.iter().all(|f| f.rms < 0.00001) {
        return Err("PROSODY_NO_VOICE".into());
    }
    let source_pitch: Vec<_> = source.iter().filter(|f| f.pitch > 0.0).collect();
    let guide_pitch: Vec<_> = guide.iter().filter(|f| f.pitch > 0.0).collect();
    if options.pitch && options.strength > 0.0 && (source_pitch.len() < 5 || guide_pitch.len() < 5)
    {
        return Err("PROSODY_NO_VOICE".into());
    }
    let source_median = median(source_pitch.iter().map(|f| f.pitch).collect()).unwrap_or(150.0);
    let guide_median = median(guide_pitch.iter().map(|f| f.pitch).collect()).unwrap_or(150.0);
    let source_rms = median(
        source
            .iter()
            .filter(|f| f.rms > 0.00001)
            .map(|f| f.rms)
            .collect(),
    )
    .unwrap_or(1.0);
    let guide_rms = median(
        guide
            .iter()
            .filter(|f| f.rms > 0.00001)
            .map(|f| f.rms)
            .collect(),
    )
    .unwrap_or(1.0);
    let sc = cumulative(source);
    let gc = cumulative(guide);
    let gt: Vec<_> = guide.iter().map(|f| f.time).collect();
    let rt: Vec<_> = guide_pitch.iter().map(|f| f.time).collect();
    let rp: Vec<_> = guide_pitch.iter().map(|f| f.pitch.ln()).collect();
    let energy: Vec<_> = guide.iter().map(|f| f.rms).collect();
    let mapped: Vec<_> = sc.iter().map(|q| interpolate(&gc, &gt, *q)).collect();
    let mut points = vec![];
    for (i, frame) in source.iter().enumerate() {
        let mut pitch = 0.0;
        if options.pitch && options.strength > 0.0 && frame.pitch > 0.0 {
            let target = source_median.ln() + interpolate(&rt, &rp, mapped[i]) - guide_median.ln();
            let shift = ((target - frame.pitch.ln()) * options.strength)
                .clamp(-4.0 * 2.0_f64.ln() / 12.0, 4.0 * 2.0_f64.ln() / 12.0);
            pitch = (frame.pitch.ln() + shift).exp().clamp(60.0, 600.0);
        }
        let lo = i.saturating_sub(10);
        let hi = (i + 10).min(source.len() - 1);
        let ratio =
            ((mapped[hi] - mapped[lo]) / (source[hi].time - source[lo].time)).clamp(0.8, 1.25);
        let duration = if options.rhythm {
            1.0 + options.strength * (ratio - 1.0)
        } else {
            1.0
        };
        let gain = if options.energy && frame.rms > source_rms * 0.05 {
            let relative =
                (interpolate(&gt, &energy, mapped[i]) / guide_rms) / (frame.rms / source_rms);
            relative
                .max(0.001)
                .powf(options.strength * 0.5)
                .clamp(0.7, 1.4)
        } else {
            1.0
        };
        points.push(Control {
            time: frame.time,
            pitch,
            duration,
            gain,
        });
    }
    // Smooth gain changes over 110 ms; never gate or erase source consonants.
    let gains: Vec<_> = points.iter().map(|p| p.gain).collect();
    for (i, p) in points.iter_mut().enumerate() {
        let lo = i.saturating_sub(5);
        let hi = (i + 6).min(gains.len());
        p.gain = gains[lo..hi].iter().sum::<f64>() / (hi - lo) as f64;
    }
    let mut output_times = vec![0.0];
    for i in 1..points.len() {
        output_times.push(
            output_times[i - 1]
                + (points[i].time - points[i - 1].time)
                    * (points[i].duration + points[i - 1].duration)
                    * 0.5,
        );
    }
    Ok(Plan {
        points,
        output_times,
    })
}
impl Plan {
    pub fn csv(&self) -> String {
        let mut text = String::from("time,pitch,duration\n");
        for p in &self.points {
            text.push_str(&format!("{:.9},{:.9},{:.9}\n", p.time, p.pitch, p.duration));
        }
        text
    }
    pub fn apply_energy(&self, samples: &mut [f64]) {
        let gains: Vec<_> = self.points.iter().map(|p| p.gain).collect();
        let duration = samples.len() as f64 / 24000.0;
        let planned = *self.output_times.last().unwrap();
        let mut peak = 0.0_f64;
        for (i, sample) in samples.iter_mut().enumerate() {
            *sample *= interpolate(
                &self.output_times,
                &gains,
                i as f64 / 24000.0 * planned / duration,
            );
            peak = peak.max(sample.abs());
        }
        if peak > 0.98 {
            for sample in samples {
                *sample *= 0.98 / peak;
            }
        }
    }
}
pub fn read_pcm(path: &Path) -> Result<Vec<f64>, String> {
    let frames = crate::audio_files::pcm_frames(path, 1, 24000, "PROSODY_RENDER_FAILED")?;
    if frames == 0 || frames > 24000 * 40 {
        return Err("PROSODY_TOO_LONG".into());
    }
    let mut file = std::fs::File::open(path).map_err(io_error)?;
    file.seek(SeekFrom::Start(12)).map_err(io_error)?;
    loop {
        let mut chunk = [0u8; 8];
        file.read_exact(&mut chunk).map_err(io_error)?;
        let size = u32::from_le_bytes(chunk[4..].try_into().unwrap()) as u64;
        if &chunk[..4] == b"data" {
            let mut bytes = vec![0; frames as usize * 2];
            file.read_exact(&mut bytes).map_err(io_error)?;
            return Ok(bytes
                .chunks_exact(2)
                .map(|v| f64::from(i16::from_le_bytes([v[0], v[1]])) / 32768.0)
                .collect());
        }
        file.seek(SeekFrom::Current((size + size % 2) as i64))
            .map_err(io_error)?;
    }
}
pub fn write_pcm(path: &Path, samples: &[f64]) -> Result<(), String> {
    if samples.is_empty() || samples.len() > 24000 * 40 || samples.iter().any(|s| !s.is_finite()) {
        return Err("PROSODY_RENDER_FAILED".into());
    }
    let raw = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(io_error)?;
    let mut file = std::io::BufWriter::with_capacity(65536, raw);
    let size = (samples.len() * 2) as u32;
    file.write_all(b"RIFF").map_err(io_error)?;
    file.write_all(&(size + 36).to_le_bytes())
        .map_err(io_error)?;
    file.write_all(b"WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00")
        .map_err(io_error)?;
    file.write_all(&24000u32.to_le_bytes()).map_err(io_error)?;
    file.write_all(&48000u32.to_le_bytes()).map_err(io_error)?;
    file.write_all(b"\x02\x00\x10\x00data").map_err(io_error)?;
    file.write_all(&size.to_le_bytes()).map_err(io_error)?;
    for sample in samples {
        file.write_all(
            &((*sample * 32768.0).round().clamp(-32768.0, 32767.0) as i16).to_le_bytes(),
        )
        .map_err(io_error)?;
    }
    file.flush().map_err(io_error)?;
    file.get_ref().sync_all().map_err(io_error)
}
