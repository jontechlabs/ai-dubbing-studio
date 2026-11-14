//! Persistent project catalogue. Project content remains in its original .dubproject folder.
use crate::{
    domain::{io_error, now, Project},
    project, Core,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, Mutex},
};
use tauri::{Emitter, Manager};
static LOCK: Mutex<()> = Mutex::new(());
static COVER_GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    key: String,
    path: PathBuf,
    project_id: String,
    name: String,
    last_opened_at: String,
    #[serde(default)]
    trashed_at: Option<String>,
    #[serde(default)]
    original_path: Option<PathBuf>,
    #[serde(default)]
    cover: Option<CoverRecord>,
    #[serde(default)]
    pending: Option<PendingMove>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingMove {
    from: PathBuf,
    to: PathBuf,
    original: Option<PathBuf>,
    trashed: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoverRecord {
    file: String,
    at_ms: u64,
    source: String,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Index {
    #[serde(default)]
    migrated: bool,
    #[serde(default)]
    items: Vec<Item>,
    #[serde(default)]
    parent: Option<PathBuf>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    key: String,
    project_id: String,
    name: String,
    path: String,
    revision: Option<u64>,
    updated_at: Option<String>,
    last_opened_at: String,
    duration_ms: Option<u64>,
    source: Option<String>,
    target: Option<String>,
    has_video: bool,
    available: bool,
    error: Option<String>,
    trashed_at: Option<String>,
    cover_at_ms: Option<u64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    entries: Vec<Entry>,
    default_parent: String,
    active_key: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cover {
    path: String,
    at_ms: u64,
    duration_ms: u64,
}
fn index_path(data: &Path) -> PathBuf {
    data.join("projects.json")
}
fn read(data: &Path) -> Result<Index, String> {
    let p = index_path(data);
    if !p.exists() {
        return Ok(Index::default());
    }
    let mut v: Index = serde_json::from_slice(&fs::read(p).map_err(io_error)?)
        .map_err(|_| "PROJECT_LIBRARY_INVALID")?;
    if v.items.len() > 10000
        || v.items
            .iter()
            .any(|i| uuid::Uuid::parse_str(&i.key).is_err() || !i.path.is_absolute())
    {
        return Err("PROJECT_LIBRARY_INVALID".into());
    }
    let mut recovered = false;
    for i in &mut v.items {
        if let Some(m) = i.pending.clone() {
            if m.to.is_dir()
                && !m.from.exists()
                && read_project(&m.to).is_ok_and(|p| p.id == i.project_id)
            {
                i.path = m.to;
                i.original_path = m.original;
                i.trashed_at = m.trashed;
                i.pending = None;
                recovered = true;
            } else if m.from.is_dir() && !m.to.exists() {
                i.pending = None;
                recovered = true
            } // Keep ambiguous moves unavailable without blocking other catalogue entries.
        }
    }
    if recovered {
        write(data, &v)?
    }
    Ok(v)
}
fn write(data: &Path, index: &Index) -> Result<(), String> {
    project::atomic_write(
        &index_path(data),
        &serde_json::to_vec_pretty(index).map_err(io_error)?,
    )
}
fn read_project(root: &Path) -> Result<Project, String> {
    let parse = |path: &Path| -> Result<Project, String> {
        let value: serde_json::Value = serde_json::from_slice(&fs::read(path).map_err(io_error)?)
            .map_err(|_| "INVALID_PROJECT")?;
        if !matches!(value["formatVersion"].as_u64(), Some(1..=29)) {
            return Err("UNSUPPORTED_PROJECT_VERSION".into());
        }
        let mut p: Project = serde_json::from_value(value).map_err(|_| "INVALID_PROJECT")?;
        p.clean_translation_approvals();
        p.validate()?;
        Ok(p)
    };
    let current = parse(&root.join("project.json"));
    if current
        .as_ref()
        .is_err_and(|e| e == "UNSUPPORTED_PROJECT_VERSION")
    {
        return current;
    }
    let pending = parse(&root.join("recovery/pending.json"));
    match (current, pending) {
        (Ok(a), Ok(b)) if a.id == b.id && b.revision > a.revision => Ok(b),
        (Ok(a), _) => Ok(a),
        (Err(_), Ok(b)) => Ok(b),
        (Err(e), Err(_)) => parse(&root.join("recovery/previous.json")).map_err(|_| e),
    }
}

fn display(p: &Path) -> String {
    let s = p.to_string_lossy();
    if let Some(u) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{u}")
    } else {
        s.strip_prefix(r"\\?\").unwrap_or(&s).to_owned()
    }
}
fn no_link(p: &Path) -> Result<(), String> {
    let m = fs::symlink_metadata(p).map_err(io_error)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if m.file_attributes() & 0x400 != 0 {
            return Err("PROJECT_LIBRARY_LINK".into());
        }
    }
    if m.file_type().is_symlink() {
        return Err("PROJECT_LIBRARY_LINK".into());
    }
    Ok(())
}
fn checked(item: &Item) -> Result<(PathBuf, Project), String> {
    if item.pending.is_some() {
        return Err("PROJECT_RECOVERY_REQUIRED".into());
    }
    no_link(&item.path)?;
    let root = item.path.canonicalize().map_err(io_error)?;
    if root != item.path {
        return Err("PROJECT_LOCATION_CHANGED".into());
    }
    let p = read_project(&root)?;
    if p.id != item.project_id {
        return Err("PROJECT_LOCATION_CHANGED".into());
    }
    Ok((root, p))
}
fn entry(item: &Item) -> Entry {
    let value = checked(item);
    let (p, error) = match value {
        Ok((_, p)) => (Some(p), None),
        Err(e) => (None, Some(e)),
    };
    Entry {
        key: item.key.clone(),
        project_id: item.project_id.clone(),
        name: p
            .as_ref()
            .map(|p| p.name.clone())
            .unwrap_or(item.name.clone()),
        path: display(&item.path),
        revision: p.as_ref().map(|p| p.revision),
        updated_at: p.as_ref().map(|p| p.updated_at.clone()),
        last_opened_at: item.last_opened_at.clone(),
        duration_ms: p
            .as_ref()
            .and_then(|p| p.media.as_ref().map(|m| m.info.duration_ms)),
        source: p.as_ref().map(|p| p.languages.source.clone()),
        target: p.as_ref().map(|p| p.languages.target.clone()),
        has_video: p.as_ref().is_some_and(|p| p.media.is_some()),
        available: p.is_some(),
        error,
        trashed_at: item.trashed_at.clone(),
        cover_at_ms: item.cover.as_ref().map(|c| c.at_ms),
    }
}
fn register(index: &mut Index, root: &Path, p: &Project, opened: bool) -> String {
    if let Some(i) = index.items.iter_mut().find(|i| i.path == root) {
        i.name = p.name.clone();
        i.project_id = p.id.clone();
        if opened {
            i.last_opened_at = now()
        }
        return i.key.clone();
    }
    let key = crate::domain::id();
    index.items.push(Item {
        key: key.clone(),
        path: root.to_owned(),
        project_id: p.id.clone(),
        name: p.name.clone(),
        last_opened_at: if opened { now() } else { p.updated_at.clone() },
        trashed_at: None,
        original_path: None,
        cover: None,
        pending: None,
    });
    key
}
pub fn remember(core: &Core, root: &Path, p: &Project, opened: bool) -> Result<(), String> {
    let _lock = LOCK.lock().map_err(io_error)?;
    let mut v = read(&core.data_dir)?;
    register(&mut v, root, p, opened);
    v.migrated = true;
    if opened {
        v.parent = root.parent().map(Path::to_owned)
    }
    write(&core.data_dir, &v)
}
pub fn idle(core: &Core) -> Result<tokio::sync::OwnedSemaphorePermit, String> {
    if crate::task_queue::active(core) {
        return Err("BUSY".into());
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
    core.gate
        .clone()
        .try_acquire_owned()
        .map_err(|_| "BUSY".into())
}
fn default_parent(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .document_dir()
        .map_err(io_error)?
        .join("AI Dubbing Studio Projects"))
}
pub fn creation_parent(
    core: &Core,
    app: &tauri::AppHandle,
    parent: Option<String>,
) -> Result<PathBuf, String> {
    let _lock = LOCK.lock().map_err(io_error)?;
    let index = read(&core.data_dir)?;
    let fallback = default_parent(app)?;
    let selected = parent
        .map(PathBuf::from)
        .or(index.parent)
        .unwrap_or(fallback.clone());
    if selected == fallback {
        fs::create_dir_all(&selected).map_err(io_error)?
    }
    selected.canonicalize().map_err(io_error)
}
pub async fn list(core: Arc<Core>, app: tauri::AppHandle) -> Result<Library, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = LOCK.lock().map_err(io_error)?;
        let mut index = read(&core.data_dir)?;
        if !index.migrated {
            index.migrated = true;
            if let Ok(recent) = fs::read_to_string(core.data_dir.join("recent.txt")) {
                if let Ok(root) = Path::new(recent.trim()).canonicalize() {
                    if let Ok(p) = read_project(&root) {
                        register(&mut index, &root, &p, false);
                        index.parent = root.parent().map(Path::to_owned)
                    }
                    if let Some(parent) = root.parent() {
                        if let Ok(children) = fs::read_dir(parent) {
                            for child in children.take(2000).flatten() {
                                let path = child.path();
                                if path.extension().is_some_and(|e| {
                                    e.to_str()
                                        .is_some_and(|s| s.eq_ignore_ascii_case("dubproject"))
                                }) && no_link(&path).is_ok()
                                {
                                    if let (Ok(root), Ok(p)) =
                                        (path.canonicalize(), read_project(&path))
                                    {
                                        register(&mut index, &root, &p, false);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            write(&core.data_dir, &index)?
        }
        let active = core
            .session
            .lock()
            .map_err(io_error)?
            .as_ref()
            .and_then(|s| {
                index
                    .items
                    .iter()
                    .find(|i| i.path == s.root)
                    .map(|i| i.key.clone())
            });
        let parent = index
            .parent
            .as_ref()
            .filter(|p| p.is_dir())
            .cloned()
            .unwrap_or(default_parent(&app)?);
        let mut entries = index.items.iter().map(entry).collect::<Vec<_>>();
        entries.sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
        Ok(Library {
            entries,
            default_parent: display(&parent),
            active_key: active,
        })
    })
    .await
    .map_err(io_error)?
}
pub fn resolve(core: &Core, key: &str) -> Result<PathBuf, String> {
    let _lock = LOCK.lock().map_err(io_error)?;
    let index = read(&core.data_dir)?;
    let item = index
        .items
        .iter()
        .find(|i| i.key == key && i.trashed_at.is_none())
        .ok_or("PROJECT_NOT_FOUND")?;
    Ok(checked(item)?.0)
}
pub async fn rename(
    core: Arc<Core>,
    app: tauri::AppHandle,
    key: String,
    revision: u64,
    name: String,
) -> Result<Entry, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = idle(&core)?;
        let name = valid_name(&name)?;
        let _lock = LOCK.lock().map_err(io_error)?;
        let mut index = read(&core.data_dir)?;
        let item = index
            .items
            .iter_mut()
            .find(|i| i.key == key && i.trashed_at.is_none())
            .ok_or("PROJECT_NOT_FOUND")?;
        let (root, mut p) = checked(item)?;
        if p.revision != revision {
            return Err("STALE_REVISION".into());
        }
        let mut session = core.session.lock().map_err(io_error)?;
        if let Some(s) = session.as_mut().filter(|s| s.root == root) {
            let mut next = s.project.clone();
            next.name = name.clone();
            p = s.replace(next, revision)?;
            app.emit("project-changed", &p).map_err(io_error)?;
        } else {
            p.name = name.clone();
            p.revision += 1;
            p.updated_at = now();
            project::save(&root, &p)?
        }
        item.name = name;
        let result = entry(item);
        write(&core.data_dir, &index)?;
        Ok(result)
    })
    .await
    .map_err(io_error)?
}
pub fn valid_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 160 || name.chars().any(char::is_control) {
        Err("INVALID_PROJECT_NAME".into())
    } else {
        Ok(name.into())
    }
}
fn commit_move(data: &Path, index: &mut Index, key: &str, m: PendingMove) -> Result<(), String> {
    let previous = index
        .items
        .iter()
        .find(|i| i.key == key)
        .ok_or("PROJECT_NOT_FOUND")?
        .clone();
    index
        .items
        .iter_mut()
        .find(|i| i.key == key)
        .unwrap()
        .pending = Some(m.clone());
    write(data, index)?;
    if let Err(e) = fs::rename(&m.from, &m.to) {
        *index.items.iter_mut().find(|i| i.key == key).unwrap() = previous;
        write(data, index)?;
        return Err(io_error(e));
    }
    let item = index.items.iter_mut().find(|i| i.key == key).unwrap();
    item.path = m.to;
    item.original_path = m.original;
    item.trashed_at = m.trashed;
    item.pending = None;
    write(data, index)
}
fn trash_move(data: &Path, index: &mut Index, key: &str, revision: u64) -> Result<Entry, String> {
    let item = index
        .items
        .iter_mut()
        .find(|i| i.key == key && i.trashed_at.is_none())
        .ok_or("PROJECT_NOT_FOUND")?;
    let (root, p) = checked(item)?;
    if p.revision != revision {
        return Err("STALE_REVISION".into());
    }
    if !root.extension().is_some_and(|e| {
        e.to_str()
            .is_some_and(|s| s.eq_ignore_ascii_case("dubproject"))
    }) {
        return Err("PROJECT_FOLDER_REQUIRED".into());
    }
    let parent = root.parent().ok_or("INVALID_PATH")?;
    let bin = parent.join(".ai-dubbing-studio-trash");
    if !bin.exists() {
        fs::create_dir(&bin).map_err(io_error)?
    }
    no_link(&bin)?;
    let bin = bin.canonicalize().map_err(io_error)?;
    if bin.parent() != Some(parent) {
        return Err("INVALID_PATH".into());
    }
    let dest = bin.join(format!("{}.dubproject", item.key));
    if dest.exists() {
        return Err("PROJECT_EXISTS".into());
    }
    let transition = PendingMove {
        from: root,
        to: dest,
        original: Some(item.path.clone()),
        trashed: Some(now()),
    };
    commit_move(data, index, key, transition)?;
    Ok(entry(index.items.iter().find(|i| i.key == key).unwrap()))
}
pub async fn trash(
    core: Arc<Core>,
    key: String,
    revision: u64,
    confirmed: bool,
) -> Result<Entry, String> {
    let _cover = COVER_GATE.acquire().await.map_err(io_error)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !confirmed {
            return Err("PROJECT_DELETE_CONFIRMATION".into());
        }
        let _permit = idle(&core)?;
        let _lock = LOCK.lock().map_err(io_error)?;
        let mut index = read(&core.data_dir)?;
        let item = index
            .items
            .iter()
            .find(|i| i.key == key)
            .ok_or("PROJECT_NOT_FOUND")?;
        if core
            .session
            .lock()
            .map_err(io_error)?
            .as_ref()
            .is_some_and(|s| s.root == item.path)
        {
            return Err("PROJECT_IS_OPEN".into());
        }
        trash_move(&core.data_dir, &mut index, &key, revision)
    })
    .await
    .map_err(io_error)?
}
fn restore_move(
    data: &Path,
    index: &mut Index,
    key: &str,
    parent: Option<String>,
) -> Result<Entry, String> {
    let item = index
        .items
        .iter_mut()
        .find(|i| i.key == key && i.trashed_at.is_some())
        .ok_or("PROJECT_NOT_FOUND")?;
    let (root, _) = checked(item)?;
    let original = item.original_path.as_ref().ok_or("INVALID_PATH")?;
    let parent = parent
        .map(PathBuf::from)
        .unwrap_or(original.parent().ok_or("INVALID_PATH")?.to_owned())
        .canonicalize()
        .map_err(io_error)?;
    let dest = parent.join(original.file_name().ok_or("INVALID_PATH")?);
    if dest.exists() {
        return Err("PROJECT_EXISTS".into());
    }
    let transition = PendingMove {
        from: root,
        to: dest,
        original: None,
        trashed: None,
    };
    commit_move(data, index, key, transition)?;
    Ok(entry(index.items.iter().find(|i| i.key == key).unwrap()))
}
pub async fn restore(
    core: Arc<Core>,
    key: String,
    parent: Option<String>,
) -> Result<Entry, String> {
    let _cover = COVER_GATE.acquire().await.map_err(io_error)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = idle(&core)?;
        let _lock = LOCK.lock().map_err(io_error)?;
        let mut i = read(&core.data_dir)?;
        restore_move(&core.data_dir, &mut i, &key, parent)
    })
    .await
    .map_err(io_error)?
}
pub async fn forget(core: Arc<Core>, key: String, confirmed: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !confirmed {
            return Err("PROJECT_DELETE_CONFIRMATION".into());
        }
        let _lock = LOCK.lock().map_err(io_error)?;
        let mut i = read(&core.data_dir)?;
        i.items
            .iter()
            .find(|i| i.key == key)
            .ok_or("PROJECT_NOT_FOUND")?;
        i.items.retain(|i| i.key != key);
        write(&core.data_dir, &i)
    })
    .await
    .map_err(io_error)?
}
pub async fn close(core: Arc<Core>, app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = idle(&core)?;
        let snapshot = core
            .session
            .lock()
            .map_err(io_error)?
            .as_ref()
            .map(|s| (s.root.clone(), s.project.clone()));
        if let Some((root, p)) = snapshot {
            remember(&core, &root, &p, false)?
        }
        *core.session.lock().map_err(io_error)? = None;
        app.emit("project-closed", ()).map_err(io_error)
    })
    .await
    .map_err(io_error)?
}
pub fn cover_point(duration: u64, requested: Option<u64>) -> Result<u64, String> {
    if duration == 0 {
        return Err("MEDIA_MISSING".into());
    }
    let at = requested.unwrap_or(120000.min(duration.saturating_mul(2) / 5));
    if at >= duration {
        return Err("INVALID_COVER_TIME".into());
    }
    Ok(at.min(duration.saturating_sub(100)))
}
pub async fn cover(
    core: Arc<Core>,
    app: tauri::AppHandle,
    key: String,
    at_ms: Option<u64>,
) -> Result<Cover, String> {
    let _permit = COVER_GATE.acquire().await.map_err(io_error)?;
    if crate::jobs::active_processing(&core) {
        return Err("BUSY".into());
    }
    let (item, root, p) = {
        let _lock = LOCK.lock().map_err(io_error)?;
        let index = read(&core.data_dir)?;
        let i = index
            .items
            .iter()
            .find(|i| i.key == key && (i.trashed_at.is_none() || at_ms.is_none()))
            .ok_or("PROJECT_NOT_FOUND")?
            .clone();
        let (r, p) = checked(&i)?;
        (i, r, p)
    };
    let media = p.media.as_ref().ok_or("MEDIA_MISSING")?;
    let source = project::asset(&root, media.preview_path.as_deref().unwrap_or(&media.path))
        .or_else(|_| project::asset(&root, &media.path))?;
    let meta = fs::metadata(&source).map_err(io_error)?;
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "{}:{}:{}:{:?}",
                media.id,
                media.info.duration_ms,
                meta.len(),
                meta.modified()
            )
            .as_bytes()
        )
    );
    let folder = core.data_dir.join("project-covers");
    fs::create_dir_all(&folder).map_err(io_error)?;
    if at_ms.is_none() {
        if let Some(c) = item.cover.as_ref().filter(|c| {
            c.source == fingerprint
                && uuid::Uuid::parse_str(c.file.trim_end_matches(".png")).is_ok()
        }) {
            let path = folder.join(&c.file);
            if path.is_file() {
                app.asset_protocol_scope()
                    .allow_file(&path)
                    .map_err(io_error)?;
                return Ok(Cover {
                    path: display(&path),
                    at_ms: c.at_ms,
                    duration_ms: media.info.duration_ms,
                });
            }
        }
    }
    let at = cover_point(
        media.info.duration_ms,
        at_ms.or(item
            .cover
            .as_ref()
            .filter(|c| c.at_ms < media.info.duration_ms)
            .map(|c| c.at_ms)),
    )?;
    let work = tempfile::tempdir_in(&folder).map_err(io_error)?;
    let image = work.path().join("frame.png");
    crate::character_review::frame(
        &core,
        &app,
        "",
        &source,
        at,
        &image,
        &AtomicBool::new(false),
    )
    .await?;
    let name = format!("{}.png", crate::domain::id());
    let path = folder.join(&name);
    fs::rename(&image, &path).map_err(io_error)?;
    {
        let _lock = LOCK.lock().map_err(io_error)?;
        let mut index = read(&core.data_dir)?;
        let current = index
            .items
            .iter_mut()
            .find(|i| i.key == key && i.path == root)
            .ok_or("PROJECT_LOCATION_CHANGED")?;
        current.cover = Some(CoverRecord {
            file: name,
            at_ms: at,
            source: fingerprint,
        });
        write(&core.data_dir, &index)?;
    }
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(io_error)?;
    Ok(Cover {
        path: display(&path),
        at_ms: at,
        duration_ms: media.info.duration_ms,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, Project, Index, String) {
        let d = tempfile::tempdir().unwrap();
        let data = d.path().join("app");
        fs::create_dir(&data).unwrap();
        let root = project::create_root(d.path(), "日本語 Projet").unwrap();
        let p = Project::new("日本語 Projet".into(), "ja".into(), "fr".into());
        project::save(&root, &p).unwrap();
        let mut i = Index::default();
        let key = register(&mut i, &root, &p, true);
        write(&data, &i).unwrap();
        (d, data, root, p, i, key)
    }
    #[test]
    fn cover_defaults_avoid_video_edges_and_accept_manual_time() {
        assert_eq!(cover_point(3_600_000, None).unwrap(), 120000);
        assert_eq!(cover_point(16000, None).unwrap(), 6400);
        assert_eq!(cover_point(2000, Some(0)).unwrap(), 0);
        assert_eq!(cover_point(2000, Some(1999)).unwrap(), 1900);
        for t in [2000, u64::MAX] {
            assert!(cover_point(2000, Some(t)).is_err())
        }
        assert!(cover_point(0, None).is_err());
        assert!(cover_point(u64::MAX, None).is_ok());
    }
    #[test]
    fn name_validation_keeps_unicode_but_rejects_empty_and_controls() {
        assert_eq!(
            valid_name("  Scène été 日本語  ").unwrap(),
            "Scène été 日本語"
        );
        for n in ["", "  ", "ligne\nligne", "tab\tname"] {
            assert!(valid_name(n).is_err())
        }
        assert!(valid_name(&"a".repeat(161)).is_err())
    }
    #[test]
    fn copied_project_ids_remain_distinct_catalogue_entries() {
        let (d, _, root, p, mut i, key) = fixture();
        let second = project::create_root(d.path(), "Copie").unwrap();
        project::save(&second, &p).unwrap();
        let other = register(&mut i, &second, &p, true);
        assert_ne!(other, key);
        assert_eq!(i.items.len(), 2);
        assert_eq!(register(&mut i, &root, &p, true), key);
        assert_eq!(i.items.len(), 2)
    }
    #[test]
    fn catalogue_read_does_not_rewrite_project_or_recovery() {
        let (_temporary, _, root, _, i, _) = fixture();
        let before = fs::read(root.join("project.json")).unwrap();
        let old = fs::read(root.join("recovery/previous.json"));
        let e = entry(&i.items[0]);
        assert!(e.available);
        assert_eq!(fs::read(root.join("project.json")).unwrap(), before);
        assert_eq!(fs::read(root.join("recovery/previous.json")).ok(), old.ok())
    }
    #[test]
    fn trash_and_restore_keep_project_assets_and_external_media_unchanged() {
        let (d, data, root, p, mut i, key) = fixture();
        fs::write(root.join("generations/take.wav"), b"TAKE").unwrap();
        fs::write(root.join("characters/reference.wav"), b"REFERENCE").unwrap();
        let external = d.path().join("original.mkv");
        fs::write(&external, b"ORIGINAL").unwrap();
        let bytes = fs::read(root.join("project.json")).unwrap();
        let e = trash_move(&data, &mut i, &key, p.revision).unwrap();
        assert!(e.trashed_at.is_some());
        assert!(!root.exists());
        assert_eq!(
            fs::read(i.items[0].path.join("generations/take.wav")).unwrap(),
            b"TAKE"
        );
        assert_eq!(fs::read(&external).unwrap(), b"ORIGINAL");
        restore_move(&data, &mut i, &key, None).unwrap();
        assert!(root.is_dir());
        assert_eq!(fs::read(root.join("project.json")).unwrap(), bytes);
        assert_eq!(
            fs::read(root.join("characters/reference.wav")).unwrap(),
            b"REFERENCE"
        );
        assert_eq!(fs::read(&external).unwrap(), b"ORIGINAL");
        assert!(i.items[0].trashed_at.is_none())
    }
    #[test]
    fn stale_or_unknown_trash_requests_leave_files_in_place() {
        let (_temporary, data, root, p, mut i, key) = fixture();
        assert!(trash_move(&data, &mut i, "../outside", p.revision).is_err());
        assert!(trash_move(&data, &mut i, &key, p.revision + 1).is_err());
        assert!(root.join("project.json").is_file())
    }
    #[test]
    fn restore_never_overwrites_an_existing_destination() {
        let (_temporary, data, root, p, mut i, key) = fixture();
        trash_move(&data, &mut i, &key, p.revision).unwrap();
        fs::create_dir(&root).unwrap();
        fs::write(root.join("keep.txt"), b"KEEP").unwrap();
        assert_eq!(
            restore_move(&data, &mut i, &key, None).unwrap_err(),
            "PROJECT_EXISTS"
        );
        assert_eq!(fs::read(root.join("keep.txt")).unwrap(), b"KEEP");
        assert!(i.items[0].path.join("project.json").is_file())
    }
    #[test]
    fn plain_folders_cannot_be_moved_as_project_trash() {
        let (d, data, root, p, mut i, key) = fixture();
        let plain = d.path().join("Documents");
        fs::rename(&root, &plain).unwrap();
        i.items[0].path = plain.canonicalize().unwrap();
        assert_eq!(
            trash_move(&data, &mut i, &key, p.revision).unwrap_err(),
            "PROJECT_FOLDER_REQUIRED"
        );
        assert!(plain.join("project.json").is_file())
    }
    #[test]
    fn interrupted_move_is_recovered_from_the_durable_journal() {
        let (_temporary, data, root, p, mut i, key) = fixture();
        let bin = root.parent().unwrap().join(".ai-dubbing-studio-trash");
        fs::create_dir(&bin).unwrap();
        let target = bin.join(format!("{key}.dubproject"));
        i.items[0].pending = Some(PendingMove {
            from: root.clone(),
            to: target.clone(),
            original: Some(root.clone()),
            trashed: Some(now()),
        });
        write(&data, &i).unwrap();
        fs::rename(&root, &target).unwrap();
        let recovered = read(&data).unwrap();
        assert!(recovered.items[0].pending.is_none());
        assert_eq!(recovered.items[0].path, target);
        assert!(recovered.items[0].trashed_at.is_some());
        assert_eq!(checked(&recovered.items[0]).unwrap().1.id, p.id)
    }
    #[test]
    fn unstarted_move_journal_keeps_the_original_project() {
        let (_temporary, data, root, _, mut i, key) = fixture();
        i.items[0].pending = Some(PendingMove {
            from: root.clone(),
            to: root
                .parent()
                .unwrap()
                .join(format!("unused-{key}.dubproject")),
            original: Some(root.clone()),
            trashed: Some(now()),
        });
        write(&data, &i).unwrap();
        let recovered = read(&data).unwrap();
        assert!(recovered.items[0].pending.is_none());
        assert_eq!(recovered.items[0].path, root);
        assert!(root.join("project.json").is_file())
    }
    #[test]
    fn replaced_project_identity_is_not_accepted() {
        let (_temporary, _, root, _, i, _) = fixture();
        let other = Project::new("Other".into(), "en".into(), "fr".into());
        project::save(&root, &other).unwrap();
        assert_eq!(
            checked(&i.items[0]).unwrap_err(),
            "PROJECT_LOCATION_CHANGED"
        );
        assert!(!entry(&i.items[0]).available)
    }
    #[test]
    fn trashed_folder_cannot_escape_through_a_link() {
        let (d, data, root, p, mut i, key) = fixture();
        let outside = d.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let bin = root.parent().unwrap().join(".ai-dubbing-studio-trash");
        #[cfg(windows)]
        {
            let ok = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&bin)
                .arg(&outside)
                .status()
                .unwrap();
            assert!(ok.success())
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &bin).unwrap();
        assert_eq!(
            trash_move(&data, &mut i, &key, p.revision).unwrap_err(),
            "PROJECT_LIBRARY_LINK"
        );
        assert!(root.join("project.json").is_file());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0)
    }
    #[test]
    fn conflicting_move_keeps_both_folders_and_other_entries_usable() {
        let (d, data, root, p, mut i, key) = fixture();
        let other = project::create_root(d.path(), "Other").unwrap();
        project::save(&other, &p).unwrap();
        register(&mut i, &other, &p, false);
        i.items[0].pending = Some(PendingMove {
            from: root.clone(),
            to: other.clone(),
            original: Some(root.clone()),
            trashed: Some(now()),
        });
        write(&data, &i).unwrap();
        let recovered = read(&data).unwrap();
        assert!(!entry(&recovered.items[0]).available);
        assert!(entry(&recovered.items[1]).available);
        assert!(root.join("project.json").is_file());
        assert!(other.join("project.json").is_file());
        assert_eq!(recovered.items[0].key, key);
    }
    #[test]
    fn future_formats_are_never_replaced_by_older_recovery_data() {
        let (_temporary, data, root, p, mut i, key) = fixture();
        project::save(&root, &p).unwrap();
        let mut next = serde_json::to_value(&p).unwrap();
        next["formatVersion"] = serde_json::json!(30);
        project::atomic_write(
            &root.join("project.json"),
            &serde_json::to_vec(&next).unwrap(),
        )
        .unwrap();
        let original = fs::read(root.join("project.json")).unwrap();
        assert_eq!(
            read_project(&root).unwrap_err(),
            "UNSUPPORTED_PROJECT_VERSION"
        );
        assert!(trash_move(&data, &mut i, &key, p.revision).is_err());
        assert_eq!(fs::read(root.join("project.json")).unwrap(), original)
    }
}
