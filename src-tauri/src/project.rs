use crate::domain::{io_error, now, valid_relative, Project};
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct Session {
    pub root: PathBuf,
    pub project: Project,
    undo: Vec<Project>,
    redo: Vec<Project>,
    history_group: Option<String>,
}
pub fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("INVALID_PATH")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(io_error)?;
    temp.write_all(data).map_err(io_error)?;
    temp.as_file().sync_all().map_err(io_error)?;
    temp.persist(path).map_err(io_error)?;
    Ok(())
}
pub fn save(root: &Path, project: &Project) -> Result<(), String> {
    project.validate()?;
    ensure_directory(root, "recovery")?;
    let bytes = serde_json::to_vec_pretty(project).map_err(io_error)?;
    let current = root.join("project.json");
    if current.exists() {
        let previous = std::fs::read(&current).map_err(io_error)?;
        if serde_json::from_slice::<Project>(&previous).is_ok_and(|p| p.validate().is_ok()) {
            atomic_write(&root.join("recovery/previous.json"), &previous)?;
        }
    }
    atomic_write(&root.join("recovery/pending.json"), &bytes)?;
    atomic_write(&current, &bytes)?;
    let _ = std::fs::remove_file(root.join("recovery/pending.json"));
    Ok(())
}
pub fn ensure_directory(root: &Path, name: &str) -> Result<PathBuf, String> {
    valid_relative(name)?;
    let path = root.join(name);
    if !path.exists() {
        std::fs::create_dir(&path).map_err(io_error)?;
    }
    let resolved = path.canonicalize().map_err(io_error)?;
    if !resolved.starts_with(root) || !resolved.is_dir() {
        return Err("INVALID_PATH".into());
    }
    Ok(resolved)
}
pub fn load(root: &Path) -> Result<Project, String> {
    let parse = |path: &Path| -> Result<Project, String> {
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).map_err(io_error)?)
                .map_err(|_| "INVALID_PROJECT".to_string())?;
        if !matches!(value["formatVersion"].as_u64(), Some(1..=9)) {
            return Err("UNSUPPORTED_PROJECT_VERSION".into());
        }
        let p: Project =
            serde_json::from_value(value).map_err(|_| "INVALID_PROJECT".to_string())?;
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
    let recovered = match (current, pending) {
        (Ok(a), Ok(b)) if a.id == b.id && b.revision > a.revision => b,
        (Ok(a), _) => a,
        (Err(_), Ok(b)) => b,
        (Err(error), Err(_)) => parse(&root.join("recovery/previous.json")).map_err(|_| error)?,
    };
    save(root, &recovered)?;
    Ok(recovered)
}
pub fn create_root(parent: &Path, name: &str) -> Result<PathBuf, String> {
    let parent = parent.canonicalize().map_err(io_error)?;
    let sanitized: String = name
        .trim()
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let sanitized = sanitized.trim_end_matches(['.', ' ']);
    if sanitized.is_empty() {
        return Err("INVALID_PROJECT".into());
    }
    let root = parent.join(format!("{sanitized}.dubproject"));
    std::fs::create_dir(&root).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            "PROJECT_EXISTS".into()
        } else {
            io_error(e)
        }
    })?;
    for folder in [
        "media",
        "subtitles",
        "stems",
        "characters",
        "generations",
        "cache",
        "exports",
        "recovery",
    ] {
        std::fs::create_dir(root.join(folder)).map_err(io_error)?;
    }
    root.canonicalize().map_err(io_error)
}
pub fn asset(root: &Path, path: &str) -> Result<PathBuf, String> {
    valid_relative(path)?;
    let resolved = root
        .join(path)
        .canonicalize()
        .map_err(|_| "MEDIA_MISSING".to_string())?;
    if !resolved.starts_with(root) {
        return Err("INVALID_PATH".into());
    }
    Ok(resolved)
}
impl Session {
    pub fn new(root: PathBuf, project: Project) -> Self {
        Self {
            root,
            project,
            undo: vec![],
            redo: vec![],
            history_group: None,
        }
    }
    pub fn import_subtitles(&mut self, text: &str, role: &str) -> Result<Project, String> {
        if !["source", "target"].contains(&role) {
            return Err("INVALID_PROJECT".into());
        }
        let cues = crate::subtitles::parse_srt(text)?;
        let mut next = self.project.clone();
        if role == "source" {
            next.source_cues = cues;
        } else {
            next.target_cues = cues;
        }
        next.dialogues = crate::subtitles::reconcile(
            &next.dialogues,
            crate::subtitles::align(&next.source_cues, &next.target_cues),
        );
        ensure_directory(&self.root, "subtitles")?;
        let name = format!("subtitles/{role}_{}.srt", crate::domain::id());
        atomic_write(&self.root.join(name), text.as_bytes())?;
        self.replace(next, self.project.revision)
    }
    pub fn replace(&mut self, next: Project, revision: u64) -> Result<Project, String> {
        self.replace_grouped(next, revision, None)
    }
    pub fn replace_grouped(
        &mut self,
        mut next: Project,
        revision: u64,
        group: Option<&str>,
    ) -> Result<Project, String> {
        if self.project.revision != revision || self.project.id != next.id {
            return Err("STALE_REVISION".into());
        }
        next.validate()?;
        next.revision = revision + 1;
        next.updated_at = now();
        save(&self.root, &next)?;
        if group.is_none() || self.history_group.as_deref() != group {
            self.undo.push(self.project.clone());
        }
        if self.undo.len() > 100 {
            self.undo.remove(0);
        }
        self.redo.clear();
        self.history_group = group.map(str::to_owned);
        self.project = next.clone();
        Ok(next)
    }
    pub fn history(&mut self, redo: bool) -> Result<Project, String> {
        self.history_group = None;
        let from = if redo { &mut self.redo } else { &mut self.undo };
        let Some(mut next) = from.last().cloned() else {
            return Ok(self.project.clone());
        };
        next.revision = self.project.revision + 1;
        next.updated_at = now();
        save(&self.root, &next)?;
        from.pop();
        if redo {
            self.undo.push(self.project.clone());
        } else {
            self.redo.push(self.project.clone());
        }
        self.project = next.clone();
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grouped_generations_use_one_undo_and_manual_edits_split_the_group() {
        let tmp = tempfile::tempdir().unwrap();
        let root = create_root(tmp.path(), "Grouped").unwrap();
        let mut s = Session::new(
            root,
            Project::new("Original".into(), "ja".into(), "fr".into()),
        );
        for (name, group) in [
            ("One", Some("batch")),
            ("Two", Some("batch")),
            ("Manual", None),
            ("Three", Some("batch")),
            ("Four", Some("batch")),
        ] {
            let mut p = s.project.clone();
            p.name = name.into();
            s.replace_grouped(p, s.project.revision, group).unwrap();
        }
        assert_eq!(s.history(false).unwrap().name, "Manual");
        assert_eq!(s.history(false).unwrap().name, "Two");
        assert_eq!(s.history(false).unwrap().name, "Original");
        assert_eq!(s.history(true).unwrap().name, "Two");
        assert_eq!(s.history(true).unwrap().name, "Manual");
        assert_eq!(s.history(true).unwrap().name, "Four");
    }
    #[test]
    fn project_reload_history_and_recovery() {
        let temp = tempfile::tempdir().unwrap();
        let root = create_root(temp.path(), "日本語 film").unwrap();
        let p = Project::new("Film".into(), "ja".into(), "fr".into());
        save(&root, &p).unwrap();
        let mut s = Session::new(root.clone(), load(&root).unwrap());
        let mut next = p.clone();
        next.name = "Edited".into();
        s.replace(next, 0).unwrap();
        assert_eq!(load(&root).unwrap().name, "Edited");
        assert_eq!(s.history(false).unwrap().name, "Film");
        assert_eq!(s.history(true).unwrap().name, "Edited");
        std::fs::write(root.join("project.json"), b"corrupt").unwrap();
        assert!(load(&root).is_ok());
    }
    #[test]
    fn rejects_stale_updates_and_traversal() {
        let t = tempfile::tempdir().unwrap();
        let root = create_root(t.path(), "A").unwrap();
        let p = Project::new("A".into(), "en".into(), "fr".into());
        save(&root, &p).unwrap();
        let mut s = Session::new(root.clone(), p.clone());
        assert!(s.replace(p, 3).is_err());
        assert!(asset(&root, "../project.json").is_err());
        assert!(valid_relative("C:/secret").is_err());
    }
}
