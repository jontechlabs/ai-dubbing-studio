use crate::{
    audio_files,
    domain::{io_error, Track},
    jobs, project, separation, Core,
};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
fn gain_at(track: &Track, frame: u64, region_index: &mut usize) -> f64 {
    if track.mute {
        return 0.0;
    }
    if track.regions_enabled == Some(false) {
        return track.gain;
    }
    while *region_index < track.regions.len()
        && u128::from(frame) * 1000 >= u128::from(track.regions[*region_index].end_ms) * 48000
    {
        *region_index += 1;
    }
    let region = track.regions.get(*region_index);
    let local = region
        .filter(|region| u128::from(frame) * 1000 >= u128::from(region.start_ms) * 48000)
        .map(|region| if region.mute { 0.0 } else { region.gain })
        .unwrap_or(1.0);
    track.gain * local
}
// Preserve source structure and duration while rendering PCM16 in bounded chunks.
pub fn render(
    input: &Path,
    output: &Path,
    track: &Track,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f64),
) -> Result<(), String> {
    let frames = audio_files::wav_frames(input)?;
    let mut source = std::io::BufReader::new(fs::File::open(input).map_err(io_error)?);
    let parent = output.parent().ok_or("INVALID_PATH")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(io_error)?;
    let mut header = [0u8; 12];
    source.read_exact(&mut header).map_err(io_error)?;
    temporary.write_all(&header).map_err(io_error)?;
    let mut header_size = 12u64;
    loop {
        let mut chunk = [0u8; 8];
        source.read_exact(&mut chunk).map_err(io_error)?;
        temporary.write_all(&chunk).map_err(io_error)?;
        if &chunk[..4] == b"data" {
            break;
        }
        let size = u32::from_le_bytes(chunk[4..].try_into().unwrap()) as u64;
        header_size += 8 + size + size % 2;
        if header_size > 1024 * 1024 {
            return Err("AUDIO_EXPORT_FAILED".into());
        }
        let mut data = vec![0u8; (size + size % 2) as usize];
        source.read_exact(&mut data).map_err(io_error)?;
        temporary.write_all(&data).map_err(io_error)?;
    }
    let mut frame = 0u64;
    let mut index = 0usize;
    let mut buffer = vec![0u8; 8192 * 4];
    let mut last = -1.0;
    while frame < frames {
        if cancel.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        let count = (frames - frame).min(8192) as usize;
        source
            .read_exact(&mut buffer[..count * 4])
            .map_err(io_error)?;
        for offset in 0..count {
            let gain = gain_at(track, frame + offset as u64, &mut index);
            for channel in 0..2 {
                let at = offset * 4 + channel * 2;
                let sample = i16::from_le_bytes([buffer[at], buffer[at + 1]]);
                let value = (f64::from(sample) * gain).round().clamp(-32768.0, 32767.0) as i16;
                buffer[at..at + 2].copy_from_slice(&value.to_le_bytes());
            }
        }
        temporary
            .write_all(&buffer[..count * 4])
            .map_err(io_error)?;
        frame += count as u64;
        let value = frame as f64 / frames as f64;
        if value - last >= 0.01 || frame == frames {
            progress(value);
            last = value;
        }
    }
    std::io::copy(&mut source, &mut temporary).map_err(io_error)?;
    if cancel.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    temporary.as_file().sync_all().map_err(io_error)?;
    temporary.persist(output).map_err(io_error)?;
    Ok(())
}
pub fn enqueue<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    id: &str,
    output: PathBuf,
) -> Result<String, String> {
    let (input, root, track, snapshot) = {
        let lock = core.session.lock().map_err(io_error)?;
        let session = lock.as_ref().ok_or("NO_PROJECT")?;
        session.project.validate()?;
        let track = session
            .project
            .tracks
            .iter()
            .find(|track| track.id == id && track.kind == "audio")
            .ok_or("INVALID_PROJECT")?
            .clone();
        (
            project::asset(&session.root, track.path.as_deref().ok_or("INVALID_PATH")?)?,
            session.root.clone(),
            track,
            session.project.clone(),
        )
    };
    let parent = output
        .parent()
        .ok_or("INVALID_PATH")?
        .canonicalize()
        .map_err(io_error)?;
    if parent.starts_with(&root) && !parent.starts_with(root.join("exports")) {
        return Err("INVALID_PATH".into());
    }
    let permit = core
        .gate
        .clone()
        .try_acquire_owned()
        .map_err(|_| "BUSY".to_string())?;
    let key = jobs::create(&core, &app, "audioExport", snapshot.id.clone(), None);
    let result_key = key.clone();
    if !crate::audio_patch::layers(&snapshot, &track.id).is_empty() {
        tauri::async_runtime::spawn(async move {
            let _permit = permit;
            let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
            jobs::update(&core, &app, &key, |j| {
                j.status = "running".into();
                j.stage = "audioRender".into();
                j.progress = Some(0.0);
            });
            let result = async {
                let temporary = tempfile::NamedTempFile::new_in(&parent)
                    .map_err(io_error)?
                    .into_temp_path();
                let duration = track
                    .duration_ms
                    .or_else(|| snapshot.media.as_ref().map(|m| m.info.duration_ms))
                    .ok_or("MEDIA_MISSING")?;
                crate::audio_patch::snippet(
                    &core,
                    &app,
                    &key,
                    &snapshot,
                    &root,
                    crate::audio_patch::Snippet {
                        track_id: &track.id,
                        start_ms: 0,
                        end_ms: duration,
                        channels: 2,
                        rate: 48000,
                        levels: crate::audio_patch::SnippetLevels::Mix,
                    },
                    &temporary,
                    &flag,
                )
                .await?;
                if flag.load(Ordering::Relaxed) {
                    return Err("CANCELLED".into());
                }
                temporary.persist(&output).map_err(io_error)?;
                Ok(())
            }
            .await;
            separation::finish(&core, &app, &key, &result);
        });
    } else {
        tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
            jobs::update(&core, &app, &key, |job| {
                job.status = "running".into();
                job.stage = "audioRender".into();
                job.progress = Some(0.0);
            });
            let result = render(&input, &output, &track, &flag, |value| {
                jobs::update(&core, &app, &key, |job| job.progress = Some(value))
            });
            separation::finish(&core, &app, &key, &result);
        });
    }
    Ok(result_key)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, PathBuf, Track) {
        let temporary = tempfile::tempdir().unwrap();
        let input = temporary.path().join("source.wav");
        let count = 144000u32;
        let size = count * 4;
        let mut bytes = vec![];
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(size + 36).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&48000u32.to_le_bytes());
        bytes.extend_from_slice(&192000u32.to_le_bytes());
        bytes.extend_from_slice(&4u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&size.to_le_bytes());
        for _ in 0..count {
            bytes.extend_from_slice(&1000i16.to_le_bytes());
            bytes.extend_from_slice(&(-1000i16).to_le_bytes());
        }
        fs::write(&input, bytes).unwrap();
        let track=serde_json::from_value(serde_json::json!({"id":"speech","kind":"audio","role":"speech","path":"stems/source.wav","durationMs":3000,"language":"en","mute":false,"solo":false,"gain":0.5,"regions":[{"id":"a","startMs":500,"endMs":1000,"gain":1,"mute":true},{"id":"b","startMs":1500,"endMs":2000,"gain":0.25,"mute":false}]})).unwrap();
        (temporary, input, track)
    }
    #[test]
    fn pcm_export_preserves_duration_source_and_independent_region_levels() {
        let (temporary, input, track) = fixture();
        let original = fs::read(&input).unwrap();
        let output = temporary.path().join("edited.wav");
        render(&input, &output, &track, &AtomicBool::new(false), |_| {}).unwrap();
        let bytes = fs::read(&output).unwrap();
        let at = |ms: usize, channel: usize| {
            let offset = 44 + ms * 48 * 4 + channel * 2;
            i16::from_le_bytes([bytes[offset], bytes[offset + 1]])
        };
        for (ms, value) in [
            (0, 500),
            (499, 500),
            (500, 0),
            (999, 0),
            (1000, 500),
            (1500, 125),
            (1999, 125),
            (2000, 500),
        ] {
            assert_eq!(at(ms, 0), value);
            assert_eq!(at(ms, 1), -value);
        }
        assert_eq!(audio_files::wav_frames(&output).unwrap(), 144000);
        assert_eq!(fs::read(input).unwrap(), original);
    }
    #[test]
    fn cancelled_render_keeps_existing_export_and_removes_temporary_output() {
        let (temporary, input, track) = fixture();
        let output = temporary.path().join("edited.wav");
        fs::write(&output, b"previous export").unwrap();
        let cancel = AtomicBool::new(false);
        assert_eq!(
            render(&input, &output, &track, &cancel, |_| cancel
                .store(true, Ordering::Relaxed))
            .unwrap_err(),
            "CANCELLED"
        );
        assert_eq!(fs::read(output).unwrap(), b"previous export");
        assert_eq!(fs::read_dir(temporary.path()).unwrap().count(), 2);
    }
    #[test]
    fn region_project_roundtrip_rejects_overlap_and_legacy_downgrade() {
        let (temporary, _input, track) = fixture();
        let mut p = crate::domain::Project::new("Audio edit".into(), "en".into(), "fr".into());
        p.format_version = 4;
        p.tracks.push(track);
        let root = temporary.path().canonicalize().unwrap();
        project::save(&root, &p).unwrap();
        let saved = project::load(&root).unwrap();
        assert_eq!(saved.tracks[0].regions[1].gain, 0.25);
        let mut invalid = saved.clone();
        invalid.tracks[0].regions[1].start_ms = 800;
        assert!(invalid.validate().is_err());
        invalid = saved;
        invalid.format_version = 3;
        assert!(invalid.validate().is_err());
    }
    #[tokio::test]
    async fn export_job_uses_a_snapshot_and_refuses_to_overwrite_project_sources() {
        let (temporary, input, track) = fixture();
        let root = temporary.path().canonicalize().unwrap();
        fs::create_dir(root.join("stems")).unwrap();
        fs::create_dir(root.join("exports")).unwrap();
        fs::rename(input, root.join("stems/source.wav")).unwrap();
        let mut p = crate::domain::Project::new("Export snapshot".into(), "en".into(), "fr".into());
        p.format_version = 4;
        p.tracks.push(track);
        let core = Arc::new(Core {
            session: std::sync::Mutex::new(Some(project::Session::new(root.clone(), p))),
            jobs: std::sync::Mutex::new(std::collections::HashMap::new()),
            gate: Arc::new(tokio::sync::Semaphore::new(1)),
            data_dir: root.clone(),
            model_dir: std::sync::Mutex::new(root.clone()),
        });
        let app = tauri::test::mock_app();
        assert_eq!(
            enqueue(
                core.clone(),
                app.handle().clone(),
                "speech",
                root.join("stems/source.wav")
            )
            .unwrap_err(),
            "INVALID_PATH"
        );
        let output = root.join("exports/edited.wav");
        let key = enqueue(core.clone(), app.handle().clone(), "speech", output.clone()).unwrap();
        core.session
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .project
            .tracks[0]
            .gain = 0.9;
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let status = core
                    .jobs
                    .lock()
                    .unwrap()
                    .get(&key)
                    .unwrap()
                    .saved
                    .record
                    .status
                    .clone();
                if status == "succeeded" {
                    break;
                }
                assert_ne!(status, "failed");
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(audio_files::wav_frames(&output).unwrap(), 144000);
        let bytes = fs::read(output).unwrap();
        assert_eq!(i16::from_le_bytes([bytes[44], bytes[45]]), 500);
    }
}
