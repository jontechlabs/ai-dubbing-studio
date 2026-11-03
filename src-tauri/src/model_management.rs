//! Delete only allowlisted weights, never shared runtimes or project assets.
use crate::{domain::io_error, model_storage, separation, Core};
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::Emitter;

#[derive(Clone)]
struct Spec {
    id: String,
    name: String,
    paths: Vec<PathBuf>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub bytes: u64,
    pub files: u64,
    pub present: bool,
    pub error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    pub id: String,
    pub bytes: u64,
    pub files: u64,
}
fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn specs<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Vec<Spec>, String> {
    let mut result = vec![
        Spec {
            id: "cosyvoice3".into(),
            name: "CosyVoice3".into(),
            paths: vec!["cosyvoice3-runtime/model".into()],
        },
        Spec {
            id: "bandit".into(),
            name: "Bandit v2 Multilingual".into(),
            paths: vec!["bandit-runtime/checkpoint-multi.ckpt".into()],
        },
        Spec {
            id: "whisper".into(),
            name: "Whisper small Q5_1".into(),
            paths: vec!["whisper-reference/ggml-small-q5_1.bin".into()],
        },
        Spec {
            id: "translation".into(),
            name: "Qwen · traduction GGUF".into(),
            paths: vec!["translation-llm/model.gguf".into()],
        },
        Spec {
            id: "musetalk".into(),
            name: "MuseTalk · modèles".into(),
            paths: vec!["musetalk-runtime/model".into()],
        },
        Spec {
            id: "latentsync".into(),
            name: "LatentSync 1.5 / 1.6 · modèles partagés".into(),
            paths: vec!["latentsync-runtime/model".into()],
        },
        Spec {
            id: "speakers".into(),
            name: "3D-Speaker + Silero + détection de visages".into(),
            paths: vec![
                "speaker-runtime/speaker.onnx".into(),
                "speaker-runtime/vad.onnx".into(),
                "speaker-runtime/yunet.onnx".into(),
            ],
        },
    ];
    for spec in &mut result {
        let partials = spec
            .paths
            .iter()
            .filter(|p| p.extension().is_some())
            .map(|p| p.with_extension("download"))
            .collect::<Vec<_>>();
        spec.paths.extend(partials);
    }
    for (file, key, prefix, group) in [
        ("voice-engines.json", "variants", "voice-engines", "voice"),
        (
            "audio-toolbox-models.json",
            "models",
            "voice-engines/audio-toolbox",
            "toolbox",
        ),
        (
            "speaker-separation-models.json",
            "models",
            "voice-engines/speaker-separation",
            "separation",
        ),
    ] {
        let data: Value = serde_json::from_slice(
            &fs::read(separation::resources(app).join(file)).map_err(io_error)?,
        )
        .map_err(io_error)?;
        for item in data[key].as_array().ok_or("INVALID_MODEL")? {
            let id = item["id"]
                .as_str()
                .filter(|id| safe_id(id))
                .ok_or("INVALID_MODEL")?;
            result.push(Spec {
                id: format!("{group}:{id}"),
                name: item["name"].as_str().unwrap_or(id).into(),
                paths: vec![Path::new(prefix).join(id)],
            });
        }
    }
    Ok(result)
}
fn no_link(path: &Path) -> Result<fs::Metadata, String> {
    let m = fs::symlink_metadata(path).map_err(io_error)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if m.file_attributes() & 0x400 != 0 {
            return Err("MODEL_STORAGE_LINK".into());
        }
    }
    if m.file_type().is_symlink() {
        return Err("MODEL_STORAGE_LINK".into());
    }
    Ok(m)
}
type OwnedFiles = (Vec<PathBuf>, Vec<PathBuf>, u64);
fn owned_files(root: &Path, spec: &Spec) -> Result<OwnedFiles, String> {
    no_link(root)?;
    let canonical = root.canonicalize().map_err(io_error)?;
    let (mut files, mut dirs, mut bytes) = (vec![], vec![], 0u64);
    for relative in &spec.paths {
        crate::domain::valid_relative(&relative.to_string_lossy())?;
        let mut current = root.to_path_buf();
        for component in relative.components() {
            current.push(component);
            if current.exists() {
                no_link(&current)?;
            } else if fs::symlink_metadata(&current).is_ok() {
                return Err("MODEL_STORAGE_LINK".into());
            }
        }
        let path = root.join(relative);
        if !path.exists() {
            continue;
        }
        let actual = path.canonicalize().map_err(io_error)?;
        if actual == canonical || !actual.starts_with(&canonical) {
            return Err("INVALID_MODEL_STORAGE".into());
        }
        let mut stack = vec![path];
        while let Some(path) = stack.pop() {
            let m = no_link(&path)?;
            if m.is_dir() {
                dirs.push(path.clone());
                for entry in fs::read_dir(path).map_err(io_error)? {
                    stack.push(entry.map_err(io_error)?.path());
                }
            } else if m.is_file() {
                bytes = bytes.saturating_add(m.len());
                files.push(path);
            } else {
                return Err("INVALID_MODEL_STORAGE".into());
            }
            if files.len() + dirs.len() > 200000 {
                return Err("INVALID_MODEL_STORAGE".into());
            }
        }
    }
    Ok((files, dirs, bytes))
}
fn remove_owned(root: &Path, spec: &Spec) -> Result<Removed, String> {
    // Preflight every path before deleting anything, including Windows junctions.
    let (files, mut dirs, bytes) = owned_files(root, spec)?;
    let count = files.len() as u64;
    for path in files {
        no_link(&path)?;
        fs::remove_file(path).map_err(io_error)?;
    }
    dirs.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    for path in dirs {
        no_link(&path)?;
        fs::remove_dir(path).map_err(io_error)?;
    }
    Ok(Removed {
        id: spec.id.clone(),
        bytes,
        files: count,
    })
}
pub async fn inventory<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
) -> Result<Vec<Entry>, String> {
    let root = model_storage::root(&core);
    let specs = specs(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&root).map_err(io_error)?;
        Ok(specs
            .into_iter()
            .map(|s| match owned_files(&root, &s) {
                Ok((f, _, bytes)) => Entry {
                    id: s.id,
                    name: s.name,
                    bytes,
                    files: f.len() as u64,
                    present: !f.is_empty(),
                    error: None,
                },
                Err(error) => Entry {
                    id: s.id,
                    name: s.name,
                    bytes: 0,
                    files: 0,
                    present: true,
                    error: Some(error),
                },
            })
            .collect())
    })
    .await
    .map_err(io_error)?
}
pub async fn remove<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    id: String,
    confirmed: bool,
) -> Result<Removed, String> {
    if !confirmed {
        return Err("MODEL_REMOVE_CONFIRMATION".into());
    }
    if core
        .jobs
        .lock()
        .map_err(io_error)?
        .values()
        .any(|j| ["queued", "running", "paused"].contains(&j.saved.record.status.as_str()))
    {
        return Err("BUSY".into());
    }
    let permit = core.gate.clone().try_acquire_owned().map_err(|_| "BUSY")?;
    let spec = specs(&app)?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or("INVALID_MODEL")?;
    let root = model_storage::root(&core);
    let removed = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        remove_owned(&root, &spec)
    })
    .await
    .map_err(io_error)??;
    app.emit("models-changed", &removed.id).map_err(io_error)?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn spec(paths: &[&str]) -> Spec {
        Spec {
            id: "test".into(),
            name: "test".into(),
            paths: paths.iter().map(PathBuf::from).collect(),
        }
    }
    #[test]
    fn removal_keeps_runtime_projects_and_other_models() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join("voice-engines/one")).unwrap();
        fs::create_dir_all(d.path().join("voice-engines/runtime")).unwrap();
        fs::write(d.path().join("voice-engines/one/model.bin"), b"weights").unwrap();
        fs::write(
            d.path().join("voice-engines/runtime/python.exe"),
            b"runtime",
        )
        .unwrap();
        fs::write(d.path().join("project.wav"), b"project").unwrap();
        let r = remove_owned(d.path(), &spec(&["voice-engines/one"])).unwrap();
        assert_eq!(r.bytes, 7);
        assert_eq!(r.files, 1);
        assert_eq!(fs::read(d.path().join("project.wav")).unwrap(), b"project");
        assert!(d.path().join("voice-engines/runtime/python.exe").is_file());
        assert_eq!(
            remove_owned(d.path(), &spec(&["voice-engines/one"]))
                .unwrap()
                .files,
            0
        );
    }
    #[test]
    fn traversal_and_storage_root_are_rejected() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("keep"), b"safe").unwrap();
        for path in ["..", "../escape", "."] {
            assert!(remove_owned(d.path(), &spec(&[path])).is_err());
        }
        assert!(d.path().join("keep").is_file());
        assert!(!safe_id("../outside"));
        assert!(!safe_id("C:\\outside"));
        assert!(safe_id("mossformer2-16k"));
    }
    #[test]
    fn nested_files_and_partial_downloads_are_counted() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join("model/cache")).unwrap();
        fs::write(d.path().join("model/model.bin"), b"123").unwrap();
        fs::write(d.path().join("model/cache/download.part"), b"12345").unwrap();
        let r = remove_owned(d.path(), &spec(&["model"])).unwrap();
        assert_eq!(r.bytes, 8);
        assert_eq!(r.files, 2);
        assert!(!d.path().join("model").exists());
    }
    #[test]
    fn links_are_rejected_before_any_weight_is_removed() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join("model")).unwrap();
        fs::create_dir_all(d.path().join("outside")).unwrap();
        fs::write(d.path().join("model/keep.bin"), b"weights").unwrap();
        fs::write(d.path().join("outside/keep.bin"), b"outside").unwrap();
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(d.path().join("model/link"))
                .arg(d.path().join("outside"))
                .status()
                .unwrap();
            assert!(status.success());
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(d.path().join("outside"), d.path().join("model/link")).unwrap();
        assert!(remove_owned(d.path(), &spec(&["model"])).is_err());
        assert!(d.path().join("model/keep.bin").is_file());
        assert_eq!(
            fs::read(d.path().join("outside/keep.bin")).unwrap(),
            b"outside"
        );
    }
}
