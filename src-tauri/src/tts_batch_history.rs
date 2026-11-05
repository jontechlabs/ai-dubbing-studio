//! Discover durable root journals, independently of the bounded job history.
use super::*;
use std::collections::HashMap;

#[cfg(test)]
#[path = "tts_batch_history_tests.rs"]
mod tests;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub report_id: String,
    pub created_at: Option<String>,
    pub variant_id: String,
    pub status: String,
    pub active_job_id: Option<String>,
    pub retry_count: usize,
    pub progress: Progress,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub items: Vec<Entry>,
    pub matching: usize,
    pub offset: u32,
    pub unreadable: usize,
}
fn date(value: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(value).ok().map(|v| {
        v.with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    })
}
pub fn list(core: &Core, offset: u32, limit: u32, problems_only: bool) -> Result<History, String> {
    if limit == 0 || limit > 100 {
        return Err("INVALID_TTS_BATCH".into());
    }
    let (root, project) = {
        let guard = core.session.lock().map_err(io_error)?;
        let s = guard.as_ref().ok_or("NO_PROJECT")?;
        (s.root.clone(), s.project.clone())
    };
    let directory = core.data_dir.join("batches");
    let mut requests = vec![];
    let mut unreadable = 0;
    if directory.exists() {
        let boundary = directory.canonicalize().map_err(io_error)?;
        for entry in std::fs::read_dir(&directory).map_err(io_error)? {
            let Ok(entry) = entry else {
                unreadable += 1;
                continue;
            };
            let id = entry.file_name().to_string_lossy().into_owned();
            if uuid::Uuid::parse_str(&id).is_err() {
                continue;
            }
            let file = entry.path().join("request.json");
            // Do not traverse redirected directories/files outside the store.
            if !file.canonicalize().is_ok_and(|p| p.starts_with(&boundary)) {
                unreadable += 1;
                continue;
            }
            match load(core, &id) {
                Ok(request)
                    if request.root == root
                        && request.project_id == project.id
                        && request.language == project.languages.target =>
                {
                    requests.push((id, request, file));
                }
                Ok(_) => (),
                Err(_) => unreadable += 1,
            }
        }
    }
    let records: HashMap<_, _> = core
        .jobs
        .lock()
        .map_err(io_error)?
        .iter()
        .filter(|(_, c)| c.saved.record.project_id == project.id)
        .map(|(id, c)| (id.clone(), c.saved.record.status.clone()))
        .collect();
    let mut live = HashMap::new();
    let mut retries: HashMap<String, usize> = HashMap::new();
    for (id, request, _) in &requests {
        let origin = request.origin_batch_id.as_ref().unwrap_or(id);
        if request.origin_batch_id.is_some() {
            *retries.entry(origin.clone()).or_default() += 1;
        }
        if let Some(status) = records
            .get(id)
            .filter(|s| ["queued", "running", "paused"].contains(&s.as_str()))
        {
            live.insert(origin.clone(), (id.clone(), status.clone()));
        }
    }
    let takes = take_index(&project);
    let mut items = vec![];
    for (id, mut request, file) in requests {
        if request.origin_batch_id.is_some() {
            continue;
        }
        for item in &mut request.items {
            if item.status != "succeeded" && committed(&takes, &root, item).is_some() {
                item.status = "succeeded".into();
                item.error = None;
            }
        }
        let progress = progress(&request, None);
        let pending = progress.total.saturating_sub(progress.completed);
        if problems_only && progress.failed == 0 && pending == 0 {
            continue;
        }
        let active = live.remove(&id);
        let status = active.as_ref().map(|(_, s)| s.clone()).unwrap_or_else(|| {
            if pending > 0 {
                if records.get(&id).is_some_and(|s| s == "cancelled") {
                    "cancelled"
                } else {
                    "interrupted"
                }
            } else if progress.failed > 0 {
                "failed"
            } else {
                "succeeded"
            }
            .into()
        });
        let created_at = request.created_at.as_deref().and_then(date).or_else(|| {
            let metadata = std::fs::metadata(&file).ok()?;
            metadata
                .created()
                .or_else(|_| metadata.modified())
                .ok()
                .map(|t| {
                    chrono::DateTime::<chrono::Utc>::from(t)
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                })
        });
        items.push(Entry {
            report_id: id.clone(),
            created_at,
            variant_id: request
                .items
                .first()
                .map(|i| i.request.options.variant_id.clone())
                .unwrap_or_default(),
            status,
            active_job_id: active.map(|(id, _)| id),
            retry_count: retries.remove(&id).unwrap_or(0),
            progress,
        });
    }
    items.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| a.report_id.cmp(&b.report_id))
    });
    let guard = core.session.lock().map_err(io_error)?;
    let s = guard.as_ref().ok_or("NO_PROJECT")?;
    if s.root != root
        || s.project.id != project.id
        || s.project.languages.target != project.languages.target
    {
        return Err("STALE_REVISION".into());
    }
    Ok(History {
        matching: items.len(),
        offset,
        unreadable,
        items: items
            .into_iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect(),
    })
}
