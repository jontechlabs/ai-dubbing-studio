//! Conservative visual timing proposals. No frames or audio leave the machine.
//! A user-selected mouth region is important for drawings and multi-person shots.
use crate::{domain::io_error, jobs, media, project, separation, Core};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::io::AsyncReadExt;
const STEP: u64 = 40;
const W: usize = 96;
const H: usize = 64;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Region {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if [self.x, self.y, self.width, self.height]
            .iter()
            .any(|v| !v.is_finite())
            || self.x < 0.0
            || self.y < 0.0
            || self.width < 0.01
            || self.height < 0.01
            || self.x + self.width > 1.000001
            || self.y + self.height > 1.000001
        {
            return Err("LIPS_REGION_REQUIRED".into());
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub line_id: String,
    pub generation_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub region: Region,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub created_at_ms: u64,
    pub root: PathBuf,
    pub project_id: String,
    pub revision: u64,
    pub source_path: String,
    pub language: String,
    pub options: Options,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub project_id: String,
    pub revision: u64,
    pub source_path: String,
    pub language: String,
    pub options: Options,
    pub start_ms: u64,
    pub duration_ms: u64,
    pub score: f64,
    pub current_score: f64,
    pub reliable: bool,
    pub warnings: Vec<String>,
    pub step_ms: u64,
    pub mouth: Vec<f64>,
    pub voice: Vec<f64>,
}

fn snapshot(core: &Core, options: &Options) -> Result<Request, String> {
    options.region.validate()?;
    let mut options = options.clone();
    let session = core.session.lock().map_err(io_error)?;
    let s = session.as_ref().ok_or("NO_PROJECT")?;
    let p = &s.project;
    let source = p.media.as_ref().ok_or("MEDIA_MISSING")?;
    if options.end_ms <= options.start_ms
        || !(1000..=30000).contains(&(options.end_ms - options.start_ms))
        || options.end_ms > source.info.duration_ms
    {
        return Err("LIPS_WINDOW_INVALID".into());
    }
    let line = p
        .dialogues
        .iter()
        .find(|l| l.id == options.line_id)
        .ok_or("NO_DIALOGUES")?;
    if line.selected_generation_ids.get(&p.languages.target) != Some(&options.generation_id) {
        return Err("INVALID_GENERATION".into());
    }
    let clips = crate::mix::clips(p);
    let index = clips
        .iter()
        .position(|c| c.id == options.generation_id)
        .ok_or("INVALID_GENERATION")?;
    if let Some(previous) = index.checked_sub(1).and_then(|i| clips.get(i)) {
        options.start_ms = options
            .start_ms
            .max(previous.start_ms() + previous.duration_ms());
    }
    if let Some(next) = clips.get(index + 1) {
        options.end_ms = options.end_ms.min(next.start_ms());
    }
    if options.end_ms < options.start_ms + 1000 {
        return Err("LIPS_WINDOW_INVALID".into());
    }
    let generation = p
        .generations
        .iter()
        .find(|g| {
            g["id"] == options.generation_id
                && g["kind"] == "tts"
                && g["sourcePath"] == source.path
                && g["dialogueId"] == line.id
                && g["language"] == p.languages.target
        })
        .ok_or("INVALID_GENERATION")?;
    if generation["durationMs"]
        .as_u64()
        .is_none_or(|n| n == 0 || n > 20000)
    {
        return Err("LIPS_TAKE_TOO_LONG".into());
    }
    project::asset(&s.root, &source.path)?;
    project::asset(
        &s.root,
        generation["path"].as_str().ok_or("INVALID_GENERATION")?,
    )?;
    Ok(Request {
        created_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(io_error)?
            .as_millis() as u64,
        root: s.root.clone(),
        project_id: p.id.clone(),
        revision: p.revision,
        source_path: source.path.clone(),
        language: p.languages.target.clone(),
        options,
    })
}
pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    options: Options,
) -> Result<String, String> {
    if core
        .jobs
        .lock()
        .map_err(io_error)?
        .values()
        .any(|j| ["queued", "running", "paused"].contains(&j.saved.record.status.as_str()))
    {
        return Err("BUSY".into());
    }
    let request = snapshot(&core, &options)?;
    let key = jobs::create(&core, &app, "lipAnalysis", request.project_id.clone(), None);
    core.jobs
        .lock()
        .map_err(io_error)?
        .get_mut(&key)
        .ok_or("INVALID_PROJECT")?
        .saved
        .lips = Some(request.clone());
    jobs::persist(&core);
    let result_key = key.clone();
    tauri::async_runtime::spawn(async move {
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        let result=async{
            let _permit=tokio::select!{_=jobs::cancelled(&flag)=>return Err("CANCELLED".into()),permit=core.gate.clone().acquire_owned()=>permit.map_err(io_error)?};
            jobs::update(&core,&app,&key,|j|{j.status="running".into();j.stage="lipsDecode".into();j.progress=Some(0.0);j.logs.push("Local mouth-region activity analysis, CPU/FFmpeg. This is a timing proposal, not phoneme recognition or generative video editing.".into());});
            let (p,root)={let session=core.session.lock().map_err(io_error)?;let s=session.as_ref().ok_or("NO_PROJECT")?;if s.root!=request.root || s.project.id!=request.project_id || s.project.revision!=request.revision{return Err("STALE_REVISION".into());}(s.project.clone(),s.root.clone())};
            let generation=p.generations.iter().find(|g|g["id"]==request.options.generation_id).ok_or("INVALID_GENERATION")?;
            let audio=crate::voice_edit::render(&root,generation["path"].as_str().ok_or("INVALID_GENERATION")?,p.voice_edits.get(&request.options.generation_id),&media::binary(&app,"ffmpeg")?,&flag).await?;
            let video=project::asset(&root,&request.source_path)?;
            let current=crate::mix::clips(&p).into_iter().find(|c|c.id==request.options.generation_id).ok_or("INVALID_GENERATION")?;
            let current_start=current.start_ms();let current_duration=current.duration_ms();
            let ffmpeg=media::binary(&app,"ffmpeg")?;
            let analysis=analyze(&ffmpeg,&video,&audio,&request,(current_start,current_duration),&flag,|progress|jobs::update(&core,&app,&key,|j|j.progress=Some(progress))).await?;
            if flag.load(Ordering::Relaxed){return Err("CANCELLED".into());}
            project::ensure_directory(&root,"cache")?;
            project::atomic_write(&root.join(format!("cache/lips-{key}.json")),&serde_json::to_vec(&analysis).map_err(io_error)?)?;
            Ok(())
        }.await;
        separation::finish(&core, &app, &key, &result);
    });
    Ok(result_key)
}
pub fn result(core: &Core, key: &str) -> Result<Option<Analysis>, String> {
    let (request, status) = {
        let jobs = core.jobs.lock().map_err(io_error)?;
        let record = &jobs.get(key).ok_or("INVALID_PROJECT")?.saved;
        (
            record.lips.clone().ok_or("INVALID_PROJECT")?,
            record.record.status.clone(),
        )
    };
    let session = core.session.lock().map_err(io_error)?;
    let s = session.as_ref().ok_or("NO_PROJECT")?;
    if s.root != request.root || s.project.id != request.project_id {
        return Err("STALE_REVISION".into());
    }
    if status != "succeeded" {
        return Ok(None);
    }
    let path = project::asset(&s.root, &format!("cache/lips-{key}.json"))?;
    if path.metadata().map_err(io_error)?.len() > 100000 {
        return Err("LIPS_ANALYSIS_FAILED".into());
    }
    Ok(Some(
        serde_json::from_slice(&std::fs::read(path).map_err(io_error)?).map_err(io_error)?,
    ))
}
pub fn latest(core: &Core, line_id: &str, generation_id: &str) -> Result<Option<String>, String> {
    let session = core.session.lock().map_err(io_error)?;
    let s = session.as_ref().ok_or("NO_PROJECT")?;
    let jobs = core.jobs.lock().map_err(io_error)?;
    Ok(jobs
        .values()
        .filter_map(|j| {
            let request = j.saved.lips.as_ref()?;
            (request.root == s.root
                && request.project_id == s.project.id
                && request.language == s.project.languages.target
                && request.options.line_id == line_id
                && request.options.generation_id == generation_id)
                .then_some((request.created_at_ms, j.saved.record.id.clone()))
        })
        .max_by_key(|(time, _)| *time)
        .map(|(_, id)| id))
}

async fn output(
    mut command: tokio::process::Command,
    limit: usize,
    flag: &AtomicBool,
) -> Result<Vec<u8>, String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(io_error)?;
    let stdout = child.stdout.take().ok_or("LIPS_ANALYSIS_FAILED")?;
    let stderr = child.stderr.take().ok_or("LIPS_ANALYSIS_FAILED")?;
    let logger = tokio::spawn(async move {
        let mut bytes = Vec::new();
        let _ = stderr.take(16384).read_to_end(&mut bytes).await;
        bytes
    });
    let work = async {
        let mut bytes = Vec::new();
        stdout
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(io_error)?;
        if bytes.len() > limit {
            return Err("LIPS_ANALYSIS_FAILED".into());
        }
        let status = child.wait().await.map_err(io_error)?;
        if !status.success() {
            return Err("LIPS_ANALYSIS_FAILED".into());
        }
        Ok(bytes)
    };
    let result = tokio::select! {_=jobs::cancelled(flag)=>Err("CANCELLED".into()),r=tokio::time::timeout(std::time::Duration::from_secs(120),work)=>r.unwrap_or_else(|_|Err("LIPS_ANALYSIS_FAILED".into()))};
    if result.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    let log = logger.await.map_err(io_error)?;
    result.map_err(|error: String| {
        if error == "LIPS_ANALYSIS_FAILED" && !log.is_empty() {
            format!("{error}: {}", String::from_utf8_lossy(&log))
        } else {
            error
        }
    })
}

pub async fn analyze(
    ffmpeg: &Path,
    video: &Path,
    audio: &Path,
    request: &Request,
    current: (u64, u64),
    flag: &AtomicBool,
    progress: impl Fn(f64),
) -> Result<Analysis, String> {
    let options = &request.options;
    options.region.validate()?;
    if crate::audio_files::pcm_frames(audio, 1, 24000, "INVALID_GENERATION")? > 20 * 24000 {
        return Err("LIPS_TAKE_TOO_LONG".into());
    }
    let region = &options.region;
    let crop = format!(
        "fps=25,crop=iw*{:.8}:ih*{:.8}:iw*{:.8}:ih*{:.8},scale={W}:{H},format=gray",
        region.width, region.height, region.x, region.y
    );
    let mut command = media::command(ffmpeg);
    command
        .args([
            "-nostdin",
            "-hide_banner",
            "-v",
            "error",
            "-threads",
            "1",
            "-filter_threads",
            "1",
            "-protocol_whitelist",
            "file,pipe",
            "-ss",
            &format!("{:.3}", options.start_ms as f64 / 1000.0),
            "-i",
        ])
        .arg(video)
        .args([
            "-t",
            &format!("{:.3}", (options.end_ms - options.start_ms) as f64 / 1000.0),
            "-an",
            "-vf",
            &crop,
            "-f",
            "rawvideo",
            "pipe:1",
        ]);
    let frames = output(command, 31 * 25 * W * H, flag).await?;
    progress(0.55);
    let mut command = media::command(ffmpeg);
    command
        .args([
            "-nostdin",
            "-hide_banner",
            "-v",
            "error",
            "-threads",
            "1",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
        ])
        .arg(audio)
        .args([
            "-vn", "-ac", "1", "-ar", "8000", "-t", "20", "-f", "f32le", "pipe:1",
        ]);
    let audio = output(command, 20 * 8000 * 4, flag).await?;
    progress(0.7);
    let (mut mouth, quality, unstable) = mouth_signal(&frames)?;
    // FFmpeg may emit a final frame whose 40 ms bin extends past an arbitrary
    // subtitle timecode. Keep proposals entirely inside the requested window.
    mouth.truncate(((options.end_ms - options.start_ms) / STEP) as usize);
    let samples: Vec<_> = audio
        .as_chunks::<4>()
        .0
        .iter()
        .map(|v| f32::from_le_bytes(*v) as f64)
        .collect();
    if samples.iter().any(|v| !v.is_finite()) {
        return Err("LIPS_VOICE_SILENT".into());
    }
    let raw_voice: Vec<_> = samples
        .chunks(320)
        .map(|chunk| (chunk.iter().map(|s| s * s).sum::<f64>() / chunk.len() as f64).sqrt())
        .collect();
    if raw_voice.iter().copied().fold(0.0, f64::max) < 0.001 {
        return Err("LIPS_VOICE_SILENT".into());
    }
    let voice = normalize(&raw_voice, 0.0);
    let fit = fit(&mouth, &voice, options.start_ms, current.0, current.1, flag)?;
    progress(0.98);
    let mut warnings = vec![];
    if quality < 0.1 {
        warnings.push("lipsLowActivity".into());
    }
    if unstable {
        warnings.push("lipsUnstableShot".into());
    }
    if fit.3 {
        warnings.push("lipsAmbiguous".into());
    }
    if fit.2 < 0.5 {
        warnings.push("lipsWeakMatch".into());
    }
    Ok(Analysis {
        project_id: request.project_id.clone(),
        revision: request.revision,
        source_path: request.source_path.clone(),
        language: request.language.clone(),
        options: options.clone(),
        start_ms: fit.0,
        duration_ms: fit.1,
        score: fit.2,
        current_score: fit.4,
        reliable: warnings.is_empty(),
        warnings,
        step_ms: STEP,
        mouth,
        voice,
    })
}
fn percentile(values: &[f64], fraction: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted[((sorted.len() - 1) as f64 * fraction).round() as usize]
}
fn normalize(values: &[f64], floor: f64) -> Vec<f64> {
    let lo = percentile(values, 0.1).min(floor);
    let hi = percentile(values, 0.95).max(lo + 0.00001);
    values
        .iter()
        .map(|v| ((v - lo) / (hi - lo)).clamp(0.0, 1.0))
        .collect()
}
fn mouth_signal(frames: &[u8]) -> Result<(Vec<f64>, f64, bool), String> {
    if frames.len() < W * H * 10 || !frames.len().is_multiple_of(W * H) {
        return Err("LIPS_ANALYSIS_FAILED".into());
    }
    let mut raw = Vec::new();
    let mut cuts = 0;
    let mut previous: Option<&[u8]> = None;
    for frame in frames.as_chunks::<{ W * H }>().0 {
        let border: Vec<_> = frame
            .iter()
            .enumerate()
            .filter(|(i, _)| {
                i % W < W / 8 || i % W >= W * 7 / 8 || i / W < H / 8 || i / W >= H * 7 / 8
            })
            .map(|(_, v)| f64::from(*v))
            .collect();
        let skin = percentile(&border, 0.7);
        let threshold = (skin - 24.0).max(0.0);
        let mut dark = 0;
        let mut n = 0;
        let mut delta = 0.0;
        for y in H / 8..H * 7 / 8 {
            for x in W / 8..W * 7 / 8 {
                let i = y * W + x;
                dark += usize::from(f64::from(frame[i]) < threshold);
                n += 1;
                if let Some(prev) = previous {
                    delta += (f64::from(frame[i]) - f64::from(prev[i])).abs() / 255.0;
                }
            }
        }
        let outer_delta = previous
            .map(|prev| {
                frame
                    .iter()
                    .zip(prev)
                    .enumerate()
                    .filter(|(i, _)| {
                        i % W < W / 8 || i % W >= W * 7 / 8 || i / W < H / 8 || i / W >= H * 7 / 8
                    })
                    .map(|(_, (&a, &b))| (f64::from(a) - f64::from(b)).abs() / 255.0)
                    .sum::<f64>()
                    / border.len() as f64
            })
            .unwrap_or(0.0);
        if outer_delta > 0.12 {
            cuts += 1;
        }
        raw.push(dark as f64 / n as f64 + 0.35 * (delta / n as f64 - outer_delta).max(0.0));
        previous = Some(frame);
    }
    let range = percentile(&raw, 0.95) - percentile(&raw, 0.1);
    let quality = (range / 0.12).clamp(0.0, 1.0);
    let lo = percentile(&raw, 0.1);
    let hi = percentile(&raw, 0.95);
    let normalized = raw
        .iter()
        .map(|v| ((v - lo) / (hi - lo).max(0.005)).clamp(0.0, 1.0))
        .collect::<Vec<_>>();
    Ok((normalized, quality, cuts as f64 / raw.len() as f64 > 0.08))
}
fn match_score(mouth: &[f64], voice: &[f64], start: f64, duration: f64) -> f64 {
    let mut intersection = 0.0;
    let mut total = 0.0;
    for (index, &m) in mouth.iter().enumerate() {
        let local = (index as f64 * STEP as f64 - start) / duration;
        let value = if (0.0..1.0).contains(&local) {
            let x = local * voice.len() as f64;
            let i = x.floor() as usize;
            let a = voice.get(i).copied().unwrap_or(0.0);
            let b = voice.get(i + 1).copied().unwrap_or(a);
            a + (b - a) * x.fract()
        } else {
            0.0
        };
        intersection += m.min(value);
        total += m + value;
    }
    if total < 0.01 {
        0.0
    } else {
        2.0 * intersection / total
    }
}
fn fit(
    mouth: &[f64],
    voice: &[f64],
    window_start: u64,
    current_start: u64,
    current_duration: u64,
    flag: &AtomicBool,
) -> Result<(u64, u64, f64, bool, f64), String> {
    if voice.is_empty() {
        return Err("LIPS_VOICE_SILENT".into());
    }
    let natural = voice.len() as f64 * STEP as f64;
    let length = mouth.len() as f64 * STEP as f64;
    let mut candidates = Vec::new();
    for rate in 0..=40 {
        if flag.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        let duration = natural * (0.67 + rate as f64 * 0.02075);
        if duration > length {
            continue;
        }
        for onset in (0..=(length - duration).floor() as u64).step_by(STEP as usize) {
            let score = match_score(mouth, voice, onset as f64, duration);
            let penalty = 0.015 * ((duration / natural).ln()).abs();
            candidates.push((score - penalty, onset, duration));
        }
    }
    candidates.sort_by(|a, b| b.0.total_cmp(&a.0));
    let best = candidates.first().ok_or("LIPS_WINDOW_INVALID")?;
    let score = match_score(mouth, voice, best.1 as f64, best.2);
    let ambiguous = candidates
        .iter()
        .any(|c| c.0 >= best.0 - 0.025 && c.1.abs_diff(best.1) > 320);
    let current_score = match_score(
        mouth,
        voice,
        current_start as f64 - window_start as f64,
        current_duration as f64,
    );
    // A proposal must never silently replace a stronger existing alignment.
    if current_score > score + 0.01
        && current_start >= window_start
        && current_start + current_duration <= window_start + length as u64
    {
        return Ok((
            current_start,
            current_duration,
            current_score,
            ambiguous,
            current_score,
        ));
    }
    Ok((
        window_start + best.1,
        best.2.round().max(1.0) as u64,
        score,
        ambiguous,
        current_score,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn real_decoding_finds_cartoon_mouth_timing_and_preserves_the_source_assets() {
        let folder = tempfile::tempdir().unwrap();
        let ffmpeg = if cfg!(windows) {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/ffmpeg.exe")
        } else {
            PathBuf::from("ffmpeg")
        };
        let video = folder.path().join("bouche.mkv");
        let audio = folder.path().join("voix.wav");
        let status=media::command(&ffmpeg).args(["-v","error","-nostdin","-y","-threads","1","-filter_threads","1","-f","lavfi","-i","color=c=0xd6ab88:s=160x90:r=25:d=5,drawbox=x=60:y=47:w=40:h=2:color=black:t=fill,drawbox=x=60:y=43:w=40:h=10:color=black:t=fill:enable='between(t,1.25,1.875)+between(t,2.125,2.75)'","-c:v","libx264","-threads","1"]).arg(&video).output().await.unwrap();
        assert!(
            status.status.success(),
            "{}",
            String::from_utf8_lossy(&status.stderr)
        );
        let status=media::command(&ffmpeg).args(["-v","error","-nostdin","-y","-f","lavfi","-i","aevalsrc=if(between(t\\,0.2\\,0.7)+between(t\\,0.9\\,1.4)\\,0.2*sin(2*PI*440*t)\\,0):s=24000:d=1.6","-c:a","pcm_s16le"]).arg(&audio).output().await.unwrap();
        assert!(
            status.status.success(),
            "{}",
            String::from_utf8_lossy(&status.stderr)
        );
        let before = (
            std::fs::read(&video).unwrap(),
            std::fs::read(&audio).unwrap(),
        );
        let request = Request {
            created_at_ms: 0,
            root: folder.path().into(),
            project_id: "fixture".into(),
            revision: 1,
            source_path: "media/source.mkv".into(),
            language: "fr".into(),
            options: Options {
                line_id: "line".into(),
                generation_id: "take".into(),
                start_ms: 0,
                end_ms: 4993,
                region: Region {
                    x: 0.3125,
                    y: 0.37777778,
                    width: 0.375,
                    height: 0.31111111,
                },
            },
        };
        let result = analyze(
            &ffmpeg,
            &video,
            &audio,
            &request,
            (400, 1600),
            &AtomicBool::new(false),
            |_| {},
        )
        .await
        .unwrap();
        assert!(result.mouth.len() as u64 * STEP <= request.options.end_ms);
        assert!(result.start_ms + result.duration_ms <= request.options.end_ms);
        assert!(
            result.start_ms.abs_diff(1000) <= 120,
            "onset {}",
            result.start_ms
        );
        assert!(
            result.duration_ms.abs_diff(2000) <= 120,
            "duration {}",
            result.duration_ms
        );
        assert!(result.score > 0.8, "score {}", result.score);
        assert!(result.reliable, "{:?}", result.warnings);
        assert_eq!(
            before,
            (
                std::fs::read(&video).unwrap(),
                std::fs::read(&audio).unwrap()
            )
        );
        assert_eq!(
            analyze(
                &ffmpeg,
                &video,
                &audio,
                &request,
                (0, 1600),
                &AtomicBool::new(true),
                |_| {}
            )
            .await
            .err()
            .unwrap(),
            "CANCELLED"
        );
    }
    #[test]
    fn rejects_invalid_regions_and_ambiguous_silent_or_cancelled_signals() {
        assert!(Region {
            x: f64::NAN,
            y: 0.0,
            width: 0.1,
            height: 0.1
        }
        .validate()
        .is_err());
        assert!(Region {
            x: 0.9,
            y: 0.0,
            width: 0.2,
            height: 0.1
        }
        .validate()
        .is_err());
        let voice = vec![1.0; 25];
        let flag = AtomicBool::new(false);
        let mut mouth = vec![0.0; 150];
        mouth[10..35].fill(1.0);
        mouth[90..115].fill(1.0);
        assert!(fit(&mouth, &voice, 0, 5000, 1000, &flag).unwrap().3);
        assert_eq!(
            fit(&mouth, &voice, 0, 0, 1000, &AtomicBool::new(true)).unwrap_err(),
            "CANCELLED"
        );
        assert_eq!(mouth_signal(&vec![220; W * H * 30]).unwrap().1, 0.0);
    }
    #[test]
    fn finds_changed_onset_and_duration_from_visible_openings_without_touching_files() {
        let voice = [
            vec![0.0; 5],
            vec![1.0; 10],
            vec![0.0; 5],
            vec![1.0; 10],
            vec![0.0; 5],
        ]
        .concat();
        let mut mouth = vec![0.0; 120];
        for (i, value) in mouth.iter_mut().enumerate() {
            let t = i as f64 * 40.0;
            let x = (t - 800.0) / 1800.0 * voice.len() as f64;
            if x >= 0.0 && x < voice.len() as f64 {
                *value = voice[x as usize];
            }
        }
        let result = fit(&mouth, &voice, 10000, 10000, 1400, &AtomicBool::new(false)).unwrap();
        assert!(result.0.abs_diff(10800) <= 80, "{}", result.0);
        assert!(result.1.abs_diff(1800) <= 80, "{}", result.1);
        assert!(result.2 > 0.85);
        assert!(!result.3);
    }
}
