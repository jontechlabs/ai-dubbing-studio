use crate::{domain::io_error, jobs, project, separation, Core};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

// Only application-owned model installations belong here. Project assets stay in projects.
const INSTALLATIONS: &[&str] = &[
    "musetalk-runtime",
    "bandit-runtime",
    "speaker-runtime",
    "cosyvoice3-runtime",
    "voice-engines",
    "whisper-reference",
];
const CONFIG: &str = "model-storage.json";
type FileEntry = (PathBuf, u64, Option<std::time::SystemTime>);

#[derive(Serialize, Deserialize)]
struct Config {
    version: u32,
    path: PathBuf,
}

pub fn load(data_dir: &Path) -> Result<PathBuf, String> {
    let path = data_dir.join(CONFIG);
    if !path.exists() {
        return Ok(data_dir.to_path_buf());
    }
    let config: Config = serde_json::from_slice(&fs::read(path).map_err(io_error)?)
        .map_err(|_| "INVALID_MODEL_STORAGE".to_string())?;
    if config.version != 1 || !config.path.is_absolute() {
        return Err("INVALID_MODEL_STORAGE".into());
    }
    // An unplugged drive must not silently fall back to a second installation.
    Ok(config.path)
}

pub fn root(core: &Core) -> PathBuf {
    core.model_dir.lock().unwrap().clone()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    path: String,
    default_path: String,
    moving: bool,
}

pub fn info(core: &Core) -> Result<Info, String> {
    let display = |path: &Path| {
        let value = path.to_string_lossy();
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{unc}")
        } else {
            value.strip_prefix(r"\\?\").unwrap_or(&value).to_owned()
        }
    };
    Ok(Info {
        path: display(&root(core)),
        default_path: display(&core.data_dir),
        moving: core.jobs.lock().map_err(io_error)?.values().any(|job| {
            job.saved.record.kind == "modelMove"
                && ["queued", "running"].contains(&job.saved.record.status.as_str())
        }),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Size {
    pub path: PathBuf,
    pub bytes: u64,
    pub files: u64,
    pub skipped: u64,
    pub partial: bool,
}
pub fn directory_size(path: &Path) -> Result<Size, String> {
    if !path.is_dir() {
        return Err("INVALID_MODEL_STORAGE".into());
    }
    let started = std::time::Instant::now();
    let mut result = Size {
        path: path.to_path_buf(),
        bytes: 0,
        files: 0,
        skipped: 0,
        partial: false,
    };
    let mut stack = vec![path.to_path_buf()];
    let mut entries = 0u64;
    while let Some(directory) = stack.pop() {
        if started.elapsed() > std::time::Duration::from_secs(20) || entries > 2_000_000 {
            result.partial = true;
            break;
        }
        let listing = match fs::read_dir(&directory) {
            Ok(value) => value,
            Err(_) => {
                result.skipped += 1;
                result.partial = true;
                continue;
            }
        };
        for entry in listing {
            entries += 1;
            if entries > 2_000_000 || started.elapsed() > std::time::Duration::from_secs(20) {
                result.partial = true;
                break;
            }
            let entry = match entry {
                Ok(value) => value,
                Err(_) => {
                    result.skipped += 1;
                    result.partial = true;
                    continue;
                }
            };
            let metadata = match check_link(&entry.path()) {
                Ok(value) => value,
                Err(error) => {
                    result.skipped += 1;
                    if error != "MODEL_STORAGE_LINK" {
                        result.partial = true;
                    }
                    continue;
                }
            };
            if metadata.is_dir() {
                stack.push(entry.path());
            } else if metadata.is_file() {
                result.bytes = result.bytes.saturating_add(metadata.len());
                result.files += 1;
            }
        }
    }
    Ok(result)
}

fn check_link(path: &Path) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("MODEL_STORAGE_LINK".into());
        }
    }
    if metadata.file_type().is_symlink() {
        return Err("MODEL_STORAGE_LINK".into());
    }
    Ok(metadata)
}

fn inventory(
    path: &Path,
    relative: &Path,
    files: &mut Vec<FileEntry>,
    dirs: &mut Vec<PathBuf>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    let metadata = check_link(path)?;
    if metadata.is_dir() {
        dirs.push(relative.to_path_buf());
        for entry in fs::read_dir(path).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            inventory(
                &entry.path(),
                &relative.join(entry.file_name()),
                files,
                dirs,
                cancel,
            )?;
        }
    } else if metadata.is_file() {
        files.push((
            relative.to_path_buf(),
            metadata.len(),
            metadata.modified().ok(),
        ));
    } else {
        return Err("INVALID_MODEL_STORAGE".into());
    }
    Ok(())
}

fn validate_destination(source: &Path, destination: &Path) -> Result<(), String> {
    if source == destination {
        return Ok(());
    }
    for name in INSTALLATIONS {
        let owned = source.join(name);
        if destination.starts_with(&owned) || owned.starts_with(destination) {
            return Err("MODEL_STORAGE_NESTED".into());
        }
        if fs::symlink_metadata(destination.join(name)).is_ok() {
            return Err(format!("MODEL_STORAGE_CONFLICT: {name}"));
        }
    }
    Ok(())
}

// Copies are verified before committing configuration. Temporary folders are RAII-owned.
// Across drives, cancellation or a failed copy leaves the original installations intact.
fn migrate(
    data_dir: &Path,
    source: &Path,
    destination: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f64),
    mut committing: impl FnMut(),
) -> Result<Vec<String>, String> {
    let source = source.canonicalize().map_err(io_error)?;
    let destination = destination.canonicalize().map_err(io_error)?;
    validate_destination(&source, &destination)?;
    if source == destination {
        return Ok(vec![]);
    }
    let mut files = vec![];
    let mut dirs = vec![];
    let mut installations = vec![];
    for name in INSTALLATIONS {
        let path = source.join(name);
        if fs::symlink_metadata(&path).is_ok() {
            if !check_link(&path)?.is_dir() {
                return Err("INVALID_MODEL_STORAGE".into());
            }
            inventory(&path, Path::new(name), &mut files, &mut dirs, cancel)?;
            installations.push(*name);
        }
    }
    let stage = tempfile::Builder::new()
        .prefix(".dubbing-models-")
        .tempdir_in(&destination)
        .map_err(io_error)?;
    for relative in &dirs {
        fs::create_dir_all(stage.path().join(relative)).map_err(io_error)?;
    }
    let total = files.iter().map(|(_, size, _)| *size as f64).sum::<f64>() * 2.0;
    let mut done = 0.0;
    let mut buffer = vec![0u8; 1024 * 1024];
    for (relative, size, _) in &files {
        let mut input = fs::File::open(source.join(relative)).map_err(io_error)?;
        let output_path = stage.path().join(relative);
        let mut output = fs::File::create(&output_path).map_err(io_error)?;
        let mut digest = Sha256::new();
        let mut copied = 0u64;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("CANCELLED".into());
            }
            let count = input.read(&mut buffer).map_err(io_error)?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count]).map_err(io_error)?;
            digest.update(&buffer[..count]);
            copied += count as u64;
            done += count as f64;
            progress(if total == 0.0 {
                0.0
            } else {
                done / total * 0.95
            });
        }
        output.sync_all().map_err(io_error)?;
        drop(output);
        drop(input);
        if copied != *size {
            return Err("MODEL_STORAGE_CHANGED".into());
        }
        let mut verification = Sha256::new();
        let mut verified = fs::File::open(&output_path).map_err(io_error)?;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("CANCELLED".into());
            }
            let count = verified.read(&mut buffer).map_err(io_error)?;
            if count == 0 {
                break;
            }
            verification.update(&buffer[..count]);
            done += count as f64;
            progress(if total == 0.0 {
                0.0
            } else {
                done / total * 0.95
            });
        }
        if digest.finalize() != verification.finalize() {
            return Err("MODEL_STORAGE_VERIFY_FAILED".into());
        }
    }
    if cancel.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    // Refuse to remove a source tree that gained, lost or changed files during copying.
    let mut final_files = vec![];
    let mut final_dirs = vec![];
    for name in &installations {
        inventory(
            &source.join(name),
            Path::new(name),
            &mut final_files,
            &mut final_dirs,
            cancel,
        )?;
    }
    files.sort();
    final_files.sort();
    dirs.sort();
    final_dirs.sort();
    if files != final_files || dirs != final_dirs {
        return Err("MODEL_STORAGE_CHANGED".into());
    }
    committing(); // No cancellation after the transaction commit starts.
    let mut published = vec![];
    let result = (|| {
        for name in &installations {
            // Refuse overwrite even if another process created a destination during the copy.
            if destination.join(name).exists() {
                return Err(format!("MODEL_STORAGE_CONFLICT: {name}"));
            }
            fs::rename(stage.path().join(name), destination.join(name)).map_err(io_error)?;
            published.push(*name);
        }
        let bytes = serde_json::to_vec(&Config {
            version: 1,
            path: destination.clone(),
        })
        .map_err(io_error)?;
        project::atomic_write(&data_dir.join(CONFIG), &bytes)
    })();
    if let Err(error) = result {
        for name in published {
            let _ = fs::rename(destination.join(name), stage.path().join(name));
        }
        return Err(error);
    }
    let mut warnings = vec![];
    for name in installations {
        let old = source.join(name);
        // The recursive target is an inventoried, non-linked application directory.
        let resolved = match old.canonicalize() {
            Ok(path) => path,
            Err(error) => {
                warnings.push(format!(
                    "Old installation retained: {} ({error})",
                    old.display()
                ));
                continue;
            }
        };
        if resolved.parent() != Some(source.as_path()) || check_link(&old).is_err() {
            warnings.push(format!("Old installation retained: {}", old.display()));
            continue;
        }
        if let Err(error) = fs::remove_dir_all(&resolved) {
            warnings.push(format!(
                "Old installation retained: {} ({error})",
                old.display()
            ));
        }
    }
    progress(1.0);
    Ok(warnings)
}

pub fn change<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    path: PathBuf,
) -> Result<String, String> {
    if !path.is_absolute() {
        return Err("INVALID_MODEL_STORAGE".into());
    }
    if core.jobs.lock().map_err(io_error)?.values().any(|job| {
        ["queued", "running", "paused"].contains(&job.saved.record.status.as_str())
            && [
                "runtime",
                "separation",
                "speakerInstall",
                "ttsInstall",
                "tts",
                "speakers",
                "modelMove",
                "referenceTranscription",
            ]
            .contains(&job.saved.record.kind.as_str())
    }) {
        return Err("BUSY".into());
    }
    let permit = core
        .gate
        .clone()
        .try_acquire_owned()
        .map_err(|_| "BUSY".to_string())?;
    let source = root(&core).canonicalize().map_err(io_error)?;
    fs::create_dir_all(&path).map_err(io_error)?;
    let destination = path.canonicalize().map_err(io_error)?;
    validate_destination(&source, &destination)?;
    let key = jobs::create(&core, &app, "modelMove", String::new(), None);
    let output = key.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let flag = core.jobs.lock().unwrap().get(&key).unwrap().cancel.clone();
        jobs::update(&core, &app, &key, |job| {
            job.status = "running".into();
            job.stage = "modelMove".into();
            job.progress = Some(0.0);
            job.logs
                .push(format!("{} → {}", source.display(), destination.display()));
        });
        let mut last = -1.0;
        let result = migrate(
            &core.data_dir,
            &source,
            &destination,
            &flag,
            |value| {
                if value - last >= 0.005 || value == 1.0 {
                    last = value;
                    jobs::update(&core, &app, &key, |job| job.progress = Some(value));
                }
            },
            || {
                jobs::update(&core, &app, &key, |job| {
                    job.stage = "modelCommit".into();
                    job.progress = Some(0.95);
                })
            },
        );
        if let Ok(warnings) = &result {
            *core.model_dir.lock().unwrap() = destination;
            jobs::update(&core, &app, &key, |job| job.logs.extend(warnings.clone()));
        }
        separation::finish(&core, &app, &key, &result.map(|_| ()));
    });
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let source = temp.path().join("old");
        let dest = temp.path().join("new");
        for dir in [&data, &source, &dest] {
            fs::create_dir(dir).unwrap();
        }
        fs::create_dir_all(source.join("bandit-runtime/python/Lib")).unwrap();
        fs::write(
            source.join("bandit-runtime/python/Lib/library.bin"),
            vec![42; 2_100_000],
        )
        .unwrap();
        fs::create_dir_all(source.join("speaker-runtime")).unwrap();
        fs::write(source.join("speaker-runtime/speaker.onnx"), b"model").unwrap();
        (temp, data, source, dest)
    }
    #[test]
    fn folder_size_counts_nested_files_without_reading_contents() {
        let temporary = tempfile::tempdir().unwrap();
        fs::create_dir(temporary.path().join("nested")).unwrap();
        fs::write(temporary.path().join("one.bin"), vec![0; 2048]).unwrap();
        fs::write(temporary.path().join("nested/two.bin"), vec![1; 4096]).unwrap();
        let size = directory_size(temporary.path()).unwrap();
        assert_eq!(size.bytes, 6144);
        assert_eq!(size.files, 2);
        assert!(!size.partial);
        assert!(directory_size(&temporary.path().join("absent")).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(temporary.path(), temporary.path().join("loop")).unwrap();
            let size = directory_size(temporary.path()).unwrap();
            assert_eq!(size.bytes, 6144);
            assert_eq!(size.skipped, 1);
        }
    }
    #[test]
    fn moves_all_installations_and_reloads_durable_path() {
        let (_temp, data, source, dest) = fixture();
        for name in [
            "cosyvoice3-runtime",
            "voice-engines",
            "whisper-reference",
            "musetalk-runtime",
        ] {
            fs::create_dir_all(source.join(name)).unwrap();
            fs::write(source.join(name).join("model.bin"), b"voice model").unwrap();
        }
        let mut progress_values = vec![];
        let warnings = migrate(
            &data,
            &source,
            &dest,
            &AtomicBool::new(false),
            |p| progress_values.push(p),
            || {},
        )
        .unwrap();
        assert!(warnings.is_empty());
        assert_eq!(load(&data).unwrap(), dest.canonicalize().unwrap());
        assert_eq!(
            fs::read(dest.join("bandit-runtime/python/Lib/library.bin")).unwrap(),
            vec![42; 2_100_000]
        );
        assert_eq!(
            fs::read(dest.join("speaker-runtime/speaker.onnx")).unwrap(),
            b"model"
        );
        assert!(!source.join("bandit-runtime").exists());
        assert!(!source.join("speaker-runtime").exists());
        for name in [
            "cosyvoice3-runtime",
            "voice-engines",
            "whisper-reference",
            "musetalk-runtime",
        ] {
            assert_eq!(
                fs::read(dest.join(name).join("model.bin")).unwrap(),
                b"voice model"
            );
            assert!(!source.join(name).exists());
        }
        assert_eq!(progress_values.last(), Some(&1.0));
        assert!(progress_values.windows(2).all(|v| v[0] <= v[1]));
    }
    #[test]
    fn cancellation_during_copy_preserves_sources_and_cleans_staging() {
        let (_temp, data, source, dest) = fixture();
        let cancel = AtomicBool::new(false);
        assert_eq!(
            migrate(
                &data,
                &source,
                &dest,
                &cancel,
                |_| cancel.store(true, Ordering::Relaxed),
                || panic!("committed cancelled move")
            )
            .unwrap_err(),
            "CANCELLED"
        );
        assert!(source.join("speaker-runtime/speaker.onnx").exists());
        assert!(!data.join(CONFIG).exists());
        assert_eq!(fs::read_dir(dest).unwrap().count(), 0);
    }
    #[test]
    fn conflicts_and_nested_paths_never_overwrite_installations() {
        let (_temp, data, source, dest) = fixture();
        fs::create_dir(dest.join("speaker-runtime")).unwrap();
        assert!(migrate(
            &data,
            &source,
            &dest,
            &AtomicBool::new(false),
            |_| {},
            || {}
        )
        .unwrap_err()
        .starts_with("MODEL_STORAGE_CONFLICT"));
        assert!(source.join("bandit-runtime").exists());
        assert!(!data.join(CONFIG).exists());
        let nested = source.join("bandit-runtime/inside");
        fs::create_dir(&nested).unwrap();
        assert_eq!(
            validate_destination(&source, &nested).unwrap_err(),
            "MODEL_STORAGE_NESTED"
        );
    }
    #[test]
    fn configuration_failure_rolls_back_published_directories() {
        let (_temp, data, source, dest) = fixture();
        fs::create_dir(data.join(CONFIG)).unwrap();
        assert!(migrate(
            &data,
            &source,
            &dest,
            &AtomicBool::new(false),
            |_| {},
            || {}
        )
        .is_err());
        assert_eq!(fs::read_dir(dest).unwrap().count(), 0);
        assert!(source.join("speaker-runtime/speaker.onnx").exists());
    }
    #[test]
    fn a_file_added_during_copy_is_never_deleted_or_lost() {
        let (_temp, data, source, dest) = fixture();
        let mut added = false;
        let result = migrate(
            &data,
            &source,
            &dest,
            &AtomicBool::new(false),
            |_| {
                if !added {
                    added = true;
                    fs::write(source.join("speaker-runtime/new-model.onnx"), b"new").unwrap();
                }
            },
            || panic!("committed changed source"),
        );
        assert_eq!(result.unwrap_err(), "MODEL_STORAGE_CHANGED");
        assert_eq!(
            fs::read(source.join("speaker-runtime/new-model.onnx")).unwrap(),
            b"new"
        );
        assert!(!data.join(CONFIG).exists());
        assert_eq!(fs::read_dir(dest).unwrap().count(), 0);
    }
    #[test]
    fn empty_storage_changes_and_unavailable_drive_never_falls_back() {
        let (_temp, data, source, dest) = fixture();
        let empty = source.join("empty");
        fs::create_dir(&empty).unwrap();
        migrate(&data, &empty, &dest, &AtomicBool::new(false), |_| {}, || {}).unwrap();
        let expected = dest.canonicalize().unwrap();
        fs::remove_dir(&dest).unwrap();
        assert_eq!(load(&data).unwrap(), expected); // no second cache
    }
    #[cfg(unix)]
    #[test]
    fn linked_model_files_are_rejected() {
        let (_temp, data, source, dest) = fixture();
        std::os::unix::fs::symlink(data.join("outside"), source.join("speaker-runtime/link"))
            .unwrap();
        assert_eq!(
            migrate(
                &data,
                &source,
                &dest,
                &AtomicBool::new(false),
                |_| {},
                || {}
            )
            .unwrap_err(),
            "MODEL_STORAGE_LINK"
        );
        assert!(!data.join(CONFIG).exists());
    }
}
