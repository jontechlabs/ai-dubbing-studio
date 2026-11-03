//! One source frame and all CPU face proposals, without editing project/video.
use crate::{
    character_review::Rect,
    domain::{io_error, Project},
    Core,
};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub character_id: String,
    pub line_id: String,
    pub at_ms: Option<u64>,
    pub profile: String,
}
#[derive(Deserialize)]
struct Detected {
    width: u32,
    height: u32,
    faces: Vec<Rect>,
}
impl Detected {
    fn validate(&self) -> Result<(), String> {
        if self.width == 0
            || self.height == 0
            || self.width > 640
            || self.height > 640
            || self.faces.len() > 32
        {
            return Err("CHARACTER_PORTRAIT_INVALID".into());
        }
        for face in &self.faces {
            face.validate()?;
        }
        Ok(())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub project_id: String,
    pub revision: u64,
    pub source_path: String,
    pub character_id: String,
    pub line_id: String,
    pub at_ms: u64,
    pub image_path: String,
    pub width: u32,
    pub height: u32,
    pub faces: Vec<Rect>,
}
fn point(project: &Project, options: &Options) -> Result<u64, String> {
    if !["auto", "anime", "live"].contains(&options.profile.as_str()) {
        return Err("FACE_PROFILE_INVALID".into());
    }
    if !project
        .characters
        .iter()
        .any(|c| c.id == options.character_id)
    {
        return Err("INVALID_CHARACTER".into());
    }
    let line = project
        .dialogues
        .iter()
        .find(|l| l.id == options.line_id)
        .ok_or("NO_DIALOGUES")?;
    let media = project.media.as_ref().ok_or("MEDIA_MISSING")?;
    let duration = line
        .end_ms
        .checked_sub(line.start_ms)
        .filter(|n| *n > 0)
        .ok_or("CHARACTER_PORTRAIT_INVALID")?;
    let at = options.at_ms.unwrap_or(line.start_ms + duration / 2);
    if at >= media.info.duration_ms {
        return Err("CHARACTER_PORTRAIT_INVALID".into());
    }
    Ok(at)
}
// Remove only our own regular cached PNGs; never traverse or remove directories.
fn prune(folder: &Path, current: &Path) {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    let mut files: Vec<_> = entries
        .filter_map(Result::ok)
        .filter(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            e.path() != current
                && e.file_type().is_ok_and(|t| t.is_file())
                && name
                    .strip_prefix("portrait-preview-")
                    .and_then(|n| n.strip_suffix(".png"))
                    .is_some_and(|n| uuid::Uuid::parse_str(n).is_ok())
        })
        .collect();
    files.sort_by_key(|e| std::cmp::Reverse(e.metadata().and_then(|m| m.modified()).ok()));
    for file in files.into_iter().skip(31) {
        let _ = std::fs::remove_file(file.path());
    }
}
pub async fn preview<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    options: Options,
) -> Result<Preview, String> {
    if crate::jobs::active_processing(&core) {
        return Err("BUSY".into());
    }
    let _permit = core.gate.clone().try_acquire_owned().map_err(|_| "BUSY")?;
    let (root, project) = {
        let guard = core.session.lock().map_err(io_error)?;
        let session = guard.as_ref().ok_or("NO_PROJECT")?;
        (session.root.clone(), session.project.clone())
    };
    let at_ms = point(&project, &options)?;
    if !crate::speakers::installed(&core) {
        return Err("SPEAKER_RUNTIME_REQUIRED".into());
    }
    let media = project.media.as_ref().ok_or("MEDIA_MISSING")?;
    let folder = core.data_dir.join("portrait-previews");
    std::fs::create_dir_all(&folder).map_err(io_error)?;
    let work = tempfile::Builder::new()
        .prefix("working-")
        .tempdir_in(&folder)
        .map_err(io_error)?;
    let image = work.path().join("frame.png");
    let output = work.path().join("result.json");
    let request = work.path().join("request.json");
    let flag = AtomicBool::new(false);
    crate::character_review::frame(
        &core,
        &app,
        "",
        &crate::project::asset(&root, &media.path)?,
        at_ms,
        &image,
        &flag,
    )
    .await?;
    crate::project::atomic_write(&request, &serde_json::to_vec(&serde_json::json!({"input":image,"output":output,"models":crate::speakers::root(&core),"profile":options.profile})).map_err(io_error)?)?;
    crate::character_review::direct_process(
        &crate::separation::python(&crate::speakers::root(&core)),
        &[
            crate::separation::resources(&app)
                .join("portrait_preview_worker.py")
                .to_string_lossy()
                .into_owned(),
            "--request".into(),
            request.to_string_lossy().into_owned(),
        ],
        &flag,
        Duration::from_secs(60),
    )
    .await?;
    let detected: Detected =
        serde_json::from_slice(&std::fs::read(&output).map_err(io_error)?).map_err(io_error)?;
    detected.validate()?;
    let guard = core.session.lock().map_err(io_error)?;
    let current = guard.as_ref().ok_or("NO_PROJECT")?;
    if current.root != root
        || current.project.id != project.id
        || current.project.revision != project.revision
        || current
            .project
            .media
            .as_ref()
            .is_none_or(|m| m.path != media.path)
    {
        return Err("STALE_REVISION".into());
    }
    let cached = folder.join(format!("portrait-preview-{}.png", crate::domain::id()));
    std::fs::copy(&image, &cached).map_err(io_error)?;
    drop(guard);
    prune(&folder, &cached);
    Ok(Preview {
        project_id: project.id,
        revision: project.revision,
        source_path: media.path.clone(),
        character_id: options.character_id,
        line_id: options.line_id,
        at_ms,
        image_path: cached.to_string_lossy().into_owned(),
        width: detected.width,
        height: detected.height,
        faces: detected.faces,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_bounds_require_a_real_character_dialogue_profile_and_media_timestamp() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = crate::tts_batch::tests::fixture(dir.path(), &["Bonjour"]);
        p.characters.push(crate::domain::Character {
            id: "speaker".into(),
            name: "Speaker".into(),
            color: "#abcdef".into(),
            references: vec![],
            default_reference_id: None,
        });
        p.media = Some(serde_json::from_value(serde_json::json!({"id":"video","path":"video.mp4","previewPath":null,"audioStreamIndex":1,"originalName":"Video","durationMs":10000,"streams":[]})).unwrap());
        let mut o = Options {
            character_id: "speaker".into(),
            line_id: p.dialogues[0].id.clone(),
            at_ms: None,
            profile: "auto".into(),
        };
        assert_eq!(point(&p, &o).unwrap(), 1000);
        o.at_ms = Some(9999);
        assert_eq!(point(&p, &o).unwrap(), 9999);
        o.at_ms = Some(10000);
        assert!(point(&p, &o).is_err());
        o.at_ms = Some(0);
        o.profile = "guess".into();
        assert!(point(&p, &o).is_err());
        o.profile = "anime".into();
        o.character_id = "missing".into();
        assert!(point(&p, &o).is_err());
        o.character_id = "speaker".into();
        o.line_id = "missing".into();
        assert!(point(&p, &o).is_err());
        assert!(Detected {
            width: 640,
            height: 480,
            faces: vec![Rect {
                x: 0.8,
                y: 0.0,
                width: 0.4,
                height: 0.3
            }]
        }
        .validate()
        .is_err());
    }
    #[test]
    fn preview_cache_pruning_retains_current_image_and_unrelated_files() {
        let dir = tempfile::tempdir().unwrap();
        let current = dir
            .path()
            .join(format!("portrait-preview-{}.png", crate::domain::id()));
        std::fs::write(&current, b"current").unwrap();
        let other = dir.path().join("user-file.png");
        std::fs::write(&other, b"retained").unwrap();
        for _ in 0..40 {
            std::fs::write(
                dir.path()
                    .join(format!("portrait-preview-{}.png", crate::domain::id())),
                b"preview",
            )
            .unwrap();
        }
        prune(dir.path(), &current);
        assert!(current.is_file() && other.is_file());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 33);
    }
}
