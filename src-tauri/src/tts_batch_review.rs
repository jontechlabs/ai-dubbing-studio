//! Read-only paginated batch outcomes and selected, idempotent recovery.
use super::*;
#[path = "tts_batch_history.rs"]
pub mod history;
#[cfg(test)]
#[path = "tts_batch_review_tests.rs"]
mod tests;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetrySelection {
    #[serde(default)]
    pub item_indices: Vec<u32>,
    pub scope: String,
    pub line_ids: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub item_index: usize,
    pub take_index: u32,
    pub line_id: String,
    pub status: String,
    pub error: Option<String>,
    pub generation_id: Option<String>,
    pub created_at: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub report_id: String,
    pub progress: Progress,
    pub matching: usize,
    pub offset: usize,
    pub items: Vec<Row>,
}
fn checked(core: &Core, key: &str) -> Result<(String, Request), String> {
    let request = load(core, key)?;
    let session = core.session.lock().map_err(io_error)?;
    let s = session.as_ref().ok_or("NO_PROJECT")?;
    if s.root != request.root
        || s.project.id != request.project_id
        || s.project.languages.target != request.language
    {
        return Err("STALE_REVISION".into());
    }
    let root = request.origin_batch_id.as_deref().unwrap_or(key).to_owned();
    let original = if root == key {
        request
    } else {
        load(core, &root)?
    };
    if original.root != s.root
        || original.project_id != s.project.id
        || original.language != s.project.languages.target
        || original.origin_batch_id.is_some()
    {
        return Err("INVALID_TTS_BATCH".into());
    }
    Ok((root, original))
}
fn take_index(p: &Project) -> std::collections::HashMap<&str, &serde_json::Value> {
    p.generations
        .iter()
        .filter(|g| g["kind"] == "tts")
        .filter_map(|g| g["batchItemId"].as_str().map(|id| (id, g)))
        .collect()
}
fn committed<'a>(
    index: &std::collections::HashMap<&str, &'a serde_json::Value>,
    root: &Path,
    item: &Item,
) -> Option<&'a serde_json::Value> {
    let g = index.get(item.request.batch_item_id.as_deref()?).copied()?;
    g["path"]
        .as_str()
        .filter(|path| project::asset(root, path).is_ok())
        .map(|_| g)
}
pub fn report(
    core: &Core,
    key: &str,
    offset: u32,
    limit: u32,
    problems_only: bool,
) -> Result<Report, String> {
    if limit == 0 || limit > 200 {
        return Err("INVALID_TTS_BATCH".into());
    }
    let (report_id, mut request) = checked(core, key)?;
    let session = core.session.lock().map_err(io_error)?;
    let s = session.as_ref().ok_or("NO_PROJECT")?;
    if s.root != request.root
        || s.project.id != request.project_id
        || s.project.languages.target != request.language
    {
        return Err("STALE_REVISION".into());
    }
    let mut rows = vec![];
    let takes = take_index(&s.project);
    for (item_index, item) in request.items.iter_mut().enumerate() {
        let generation = item
            .request
            .batch_item_id
            .as_deref()
            .and_then(|id| takes.get(id))
            .copied();
        if item.status != "succeeded" && committed(&takes, &s.root, item).is_some() {
            item.status = "succeeded".into();
            item.error = None;
        }
        if !problems_only || matches!(item.status.as_str(), "failed" | "pending") {
            rows.push(Row {
                item_index,
                take_index: item.take_index + 1,
                line_id: item.request.line_id.clone(),
                status: item.status.clone(),
                error: item.error.clone(),
                generation_id: generation.and_then(|g| g["id"].as_str()).map(str::to_owned),
                created_at: generation
                    .and_then(|g| g["createdAt"].as_str())
                    .map(str::to_owned),
            });
        }
    }
    let matching = rows.len();
    Ok(Report {
        report_id,
        progress: progress(&request, None),
        matching,
        offset: offset as usize,
        items: rows
            .into_iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect(),
    })
}
pub(super) fn record_origin(core: &Core, request: &Request, item: &Item) -> Result<(), String> {
    let Some(root) = request.origin_batch_id.as_deref() else {
        return Ok(());
    };
    // Indices are resolved against the original request before enqueueing a
    // retry. Avoid reparsing a potentially large batch for every finished line.
    let index = item.origin_index.ok_or("INVALID_TTS_BATCH")?;
    record_item(core, root, index, item)
}
pub fn retry<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    key: &str,
    selection: RetrySelection,
) -> Result<String, String> {
    retry_with_launch(core, app, key, selection, None)
}
pub(super) fn retry_with_launch<R: tauri::Runtime>(
    core: Arc<Core>,
    app: tauri::AppHandle<R>,
    key: &str,
    selection: RetrySelection,
    launch: Option<tts::WorkerLaunch>,
) -> Result<String, String> {
    if !["failed", "unfinished", "selected"].contains(&selection.scope.as_str())
        || (selection.scope != "selected"
            && (!selection.line_ids.is_empty() || !selection.item_indices.is_empty()))
    {
        return Err("INVALID_TTS_BATCH".into());
    }
    if tts::busy(&core) {
        return Err("BUSY".into());
    }
    let (root, original) = checked(&core, key)?;
    let ids: HashSet<_> = selection.line_ids.iter().collect();
    let indices: HashSet<_> = selection.item_indices.iter().map(|v| *v as usize).collect();
    let session = core.session.lock().map_err(io_error)?;
    let s = session.as_ref().ok_or("NO_PROJECT")?;
    if s.root != original.root
        || s.project.id != original.project_id
        || s.project.languages.target != original.language
    {
        return Err("STALE_REVISION".into());
    }
    if original.approved_only && original.unapproved_only {
        return Err("INVALID_TTS_BATCH".into());
    }
    let takes = take_index(&s.project);
    if selection.scope == "selected"
        && ((ids.is_empty() && indices.is_empty())
            || indices.iter().any(|index| {
                original.items.get(*index).is_none_or(|i| {
                    !matches!(i.status.as_str(), "failed" | "pending")
                        || committed(&takes, &s.root, i).is_some()
                })
            })
            || ids.iter().any(|id| {
                !original.items.iter().any(|i| {
                    i.request.line_id.as_str() == id.as_str()
                        && matches!(i.status.as_str(), "failed" | "pending")
                        && committed(&takes, &s.root, i).is_none()
                })
            }))
    {
        return Err("INVALID_TTS_BATCH".into());
    }
    let approvals = if original.approved_only || original.unapproved_only {
        let mut p = s.project.clone();
        p.clean_translation_approvals();
        Some(p.translation_approvals)
    } else {
        None
    };
    let mut items = vec![];
    for (index, old) in original.items.iter().enumerate() {
        let wanted = match selection.scope.as_str() {
            "failed" => old.status == "failed",
            "unfinished" => matches!(old.status.as_str(), "failed" | "pending"),
            _ => {
                (indices.contains(&index) || ids.contains(&old.request.line_id))
                    && matches!(old.status.as_str(), "failed" | "pending")
            }
        };
        if !wanted || committed(&takes, &s.root, old).is_some() {
            continue;
        }
        let prepared = s
            .project
            .dialogues
            .iter()
            .find(|l| l.id == old.request.line_id)
            .ok_or_else(|| "NO_DIALOGUES".to_owned())
            .and_then(|l| {
                if !translated(&s.project, l) {
                    return Err("TRANSLATION_REQUIRED".into());
                }
                if original.approved_only
                    && !approvals.as_ref().is_some_and(|a| a.contains_key(&l.id))
                {
                    return Err("TTS_BATCH_TRANSLATION_UNAPPROVED".into());
                }
                if original.unapproved_only
                    && approvals.as_ref().is_some_and(|a| a.contains_key(&l.id))
                {
                    return Err("TTS_BATCH_TRANSLATION_APPROVED".into());
                }
                tts::prepare_request(
                    &s.project,
                    &s.root,
                    l.id.clone(),
                    old.request.options.clone(),
                )
            });
        let item = match prepared {
            Ok(mut request) => {
                if launch.is_none() && !tts::runtime_installed(&core, &request.options) {
                    return Err("TTS_RUNTIME_REQUIRED".into());
                }
                request.batch_item_id = old.request.batch_item_id.clone();
                Item {
                    take_index: old.take_index,
                    origin_index: Some(index),
                    request,
                    status: "pending".into(),
                    error: None,
                }
            }
            Err(error) => Item {
                take_index: old.take_index,
                origin_index: Some(index),
                request: old.request.clone(),
                status: "failed".into(),
                error: Some(error),
            },
        };
        items.push(item);
    }
    drop(session);
    if items.is_empty() {
        return Err("TTS_BATCH_EMPTY".into());
    }
    start_with_launch(
        core,
        app,
        Request {
            origin_batch_id: Some(root),
            items,
            skipped: 0,
            ..original
        },
        None,
        launch,
    )
}
