//! Conservative, offline installation budget. No Python or network is needed.
use crate::{domain::io_error, model_storage, separation, tts, voice_engines, Core};
use serde::Serialize;
use std::path::Path;
const GIB: u64 = 1024 * 1024 * 1024;
const EXPANDED_RUNTIME: u64 = 12 * GIB;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Space {
    pub path: String,
    pub available_bytes: u64,
    pub required_bytes: u64,
    pub model_bytes: u64,
    pub download_bytes: u64,
    pub runtime_bytes: u64,
    pub margin_bytes: u64,
    pub enough: bool,
}
fn complete(path: &Path, size: u64) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() == size)
}
pub fn check<R: tauri::Runtime>(core: &Core, app: &tauri::AppHandle<R>) -> Result<Space, String> {
    let folder = voice_engines::root(core);
    let model = folder.join("drama3-comfy-fp8");
    let runtime = folder.join("drama-runtime");
    let variant = voice_engines::variant(app, "drama3-comfy-fp8")?;
    let model_bytes = variant
        .files
        .iter()
        .filter(|f| !complete(&model.join(&f.name), f.size))
        .map(|f| f.size)
        .sum();
    let files: serde_json::Value = serde_json::from_slice(
        &std::fs::read(separation::resources(app).join("drama-runtime.json")).map_err(io_error)?,
    )
    .map_err(io_error)?;
    let mut download_bytes = if complete(&runtime.join("python.zip"), 11133606) {
        0
    } else {
        11133606
    };
    for file in files["files"].as_array().ok_or("TTS_RUNTIME_FAILED")? {
        if file["bundledPath"].is_string() {
            continue;
        }
        let name = file["name"].as_str().ok_or("TTS_RUNTIME_FAILED")?;
        crate::domain::valid_relative(name)?;
        let size = file["size"].as_u64().ok_or("TTS_RUNTIME_FAILED")?;
        if !complete(&runtime.join("wheels").join(name), size)
            && !complete(&tts::root(core).join("wheels").join(name), size)
        {
            download_bytes += size;
        }
    }
    // The pinned CUDA torch wheel expands to 6.88 GiB. Reserve 12 GiB for all
    // expanded dependencies/core and deduct existing app-owned runtime payload.
    // File lengths are an estimate here; SHA-256 remains mandatory at install.
    let mut present = 0;
    for part in ["python", "core"] {
        let path = runtime.join(part);
        if path.is_dir() {
            let size = model_storage::directory_size(&path)?;
            if !size.partial {
                present += size.bytes;
            }
        }
    }
    let available = available(&folder)?;
    let value = folder.to_string_lossy();
    let display = if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_owned()
    };
    Ok(budget(
        display,
        available,
        model_bytes,
        download_bytes,
        present,
    ))
}
fn budget(
    path: String,
    available_bytes: u64,
    model_bytes: u64,
    download_bytes: u64,
    present: u64,
) -> Space {
    let runtime_bytes = EXPANDED_RUNTIME.saturating_sub(present);
    let margin_bytes = 2 * GIB;
    let required_bytes = model_bytes + download_bytes + runtime_bytes + margin_bytes;
    Space {
        path,
        available_bytes,
        required_bytes,
        model_bytes,
        download_bytes,
        runtime_bytes,
        margin_bytes,
        enough: available_bytes >= required_bytes,
    }
}
#[cfg(windows)]
fn available(path: &Path) -> Result<u64, String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        #[link_name = "GetDiskFreeSpaceExW"]
        fn get_disk_free_space_ex_w(
            directory: *const u16,
            available: *mut u64,
            total: *mut u64,
            free: *mut u64,
        ) -> i32;
    }
    // New storage folders may not exist yet; query their existing ancestor on
    // the same drive. An unplugged drive never falls back to the default disk.
    let existing = path
        .ancestors()
        .find(|p| p.is_dir())
        .ok_or("INVALID_MODEL_STORAGE")?;
    let name: Vec<_> = existing.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut bytes = 0;
    if unsafe {
        get_disk_free_space_ex_w(
            name.as_ptr(),
            &mut bytes,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(format!("IO_ERROR: {}", std::io::Error::last_os_error()));
    }
    Ok(bytes)
}
#[cfg(not(windows))]
fn available(_path: &Path) -> Result<u64, String> {
    Err("RUNTIME_PLATFORM_UNSUPPORTED".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_install_includes_downloads_expansion_models_and_margin() {
        let plan = budget("F:/models".into(), 60 * GIB, 38 * GIB, 4 * GIB, 0);
        assert_eq!(plan.required_bytes, 56 * GIB);
        assert!(plan.enough);
        assert!(!budget(plan.path, plan.required_bytes - 1, 38 * GIB, 4 * GIB, 0).enough);
    }
    #[test]
    fn resume_deducts_existing_runtime_and_cached_downloads_without_negative_budget() {
        let plan = budget("F:/models".into(), 40 * GIB, 37 * GIB, 0, 10 * GIB);
        assert_eq!(plan.required_bytes, 41 * GIB);
        assert!(!plan.enough);
        assert_eq!(
            budget(plan.path, 2 * GIB, 0, 0, 13 * GIB).required_bytes,
            2 * GIB
        );
    }
    #[cfg(windows)]
    #[test]
    fn real_windows_query_supports_existing_and_missing_child_directories() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(available(tmp.path()).unwrap() > 0);
        assert!(available(&std::fs::canonicalize(tmp.path()).unwrap()).unwrap() > 0);
        assert!(available(&tmp.path().join("not-created/child")).unwrap() > 0);
    }
}
