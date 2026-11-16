//! Read-only, bounded queue forecasts. No audio reads or job-history writes.
use super::*;
use crate::{
    generation_timing::{History, Query},
    work_estimate::{Active, Forecast},
};
use std::collections::HashMap;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedTake {
    line_id: String,
    query: Option<Query>,
    initial_ms: Option<u64>,
}
pub(super) fn capture(p: &Project, root: &std::path::Path, spec: &Spec) -> Vec<PlannedTake> {
    if !spec.dubbing {
        return vec![];
    }
    let mut selection = spec.selection.clone();
    let missing_speech =
        spec.separation.is_some() && selection.options.reference_mode == "current" && {
            let speech = crate::mix::tracks(p).into_iter().find(|t| {
                t.role.as_deref() == Some("speech")
                    && t.source_path.as_deref() == p.media.as_ref().map(|m| m.path.as_str())
            });
            selection.options.reference_track_id = speech.map(|t| t.id);
            selection.options.reference_track_id.is_none()
        };
    let Ok((preview, items)) = tts_batch::plan(p, root, &selection) else {
        return vec![];
    };
    let mut history = History::new(p);
    let owner = |id: &str| {
        if spec.selection.line_ids.iter().any(|s| s == id) {
            return id.to_owned();
        }
        p.speaker_dubbings
            .iter()
            .find(|g| g.active && g.voices.iter().any(|v| v.line_id == id))
            .map(|g| g.parent_id.clone())
            .unwrap_or_else(|| id.into())
    };
    let mut plan: Vec<_> = items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let query = if missing_speech {
                None
            } else {
                p.dialogues
                    .iter()
                    .find(|l| l.id == item.request.line_id)
                    .and_then(|l| tts::timing_query(p, l, &item.request.options, index > 0).ok())
            };
            let initial_ms = query.as_ref().and_then(|q| history.predict(q));
            PlannedTake {
                line_id: owner(&item.request.line_id),
                query,
                initial_ms,
            }
        })
        .collect();
    for blocked in preview.blocked {
        for _ in 0..spec.selection.take_count.unwrap_or(1) {
            plan.push(PlannedTake {
                line_id: owner(&blocked.line_id),
                query: None,
                initial_ms: None,
            });
        }
    }
    plan
}
struct JobState {
    status: String,
    kind: String,
    work: Option<Forecast>,
    step: Option<crate::generation_timing::Estimate>,
}
pub(super) struct Estimator {
    history: Option<History>,
    project_id: Option<String>,
    jobs: HashMap<String, JobState>,
    separations: Vec<(audio_toolbox::Options, u64)>,
}
impl Estimator {
    pub fn new(core: &Core) -> Self {
        let (project_id, history) = core
            .session
            .lock()
            .ok()
            .and_then(|s| {
                s.as_ref()
                    .map(|s| (Some(s.project.id.clone()), Some(History::new(&s.project))))
            })
            .unwrap_or_default();
        let mut jobs = HashMap::new();
        let mut separations = vec![];
        if let Ok(guard) = core.jobs.lock() {
            let mut recent: Vec<_> = guard.values().collect();
            recent.sort_by_key(|j| {
                std::cmp::Reverse(
                    j.saved
                        .record
                        .timing
                        .as_ref()
                        .map_or(0, |t| t.observed_at_ms),
                )
            });
            for j in recent.into_iter().take(512) {
                let r = &j.saved.record;
                if r.status == "succeeded" {
                    if let (Some(request), Some(t)) = (&j.saved.toolbox_request, &r.timing) {
                        if (1..=86400000).contains(&t.elapsed_ms) {
                            separations.push((request.options.clone(), t.elapsed_ms));
                        }
                    }
                }
                if ["running", "queued", "paused"].contains(&r.status.as_str()) {
                    jobs.insert(
                        r.id.clone(),
                        JobState {
                            status: r.status.clone(),
                            kind: r.kind.clone(),
                            work: r.work_estimate.clone(),
                            step: r.estimate.clone(),
                        },
                    );
                }
            }
        }
        Self {
            project_id,
            history,
            jobs,
            separations,
        }
    }
    fn separation(&self, s: &Separation, duration: u64) -> Option<u64> {
        let mut nearby: Vec<_> = self
            .separations
            .iter()
            .filter_map(|(o, ms)| {
                let units = o.end_ms.saturating_sub(o.start_ms);
                (o.model_id == s.model_id
                    && o.device == s.device
                    && o.window_seconds == s.window_seconds
                    && o.prompt.is_empty()
                    && units * 3 >= duration * 2
                    && units * 2 <= duration * 3)
                    .then_some((units.abs_diff(duration), *ms))
            })
            .collect();
        nearby.sort_by_key(|s| s.0);
        nearby.truncate(5);
        let mut ms: Vec<_> = nearby.into_iter().map(|s| s.1).collect();
        ms.sort_unstable();
        ms.get(ms.len() / 2).copied()
    }
    pub fn entry(&mut self, e: &Entry) -> Option<Forecast> {
        if !["running", "pending"].contains(&e.status.as_str()) {
            return None;
        }
        let mut result = Forecast::default();
        if let Some(s) = &e.spec.separation {
            for row in e
                .rows
                .iter()
                .filter(|r| ["running", "pending"].contains(&r.status.as_str()))
            {
                let ms = self.separation(s, row.end_ms.saturating_sub(row.start_ms));
                if row.status == "running" {
                    if let Some((id, j)) = row
                        .job_id
                        .as_ref()
                        .and_then(|id| self.jobs.get(id).map(|j| (id, j)))
                    {
                        if j.status == "running" {
                            result.active = Some(Active {
                                job_id: id.clone(),
                                estimated_ms: ms,
                                baseline_elapsed_ms: 0,
                            });
                            continue;
                        }
                    }
                }
                result.push(ms);
            }
        }
        if e.spec.dubbing {
            let active = e.dubbing_runs.iter().find(|r| r.status == "running");
            let active_work = active
                .and_then(|r| r.job_id.as_ref())
                .and_then(|id| self.jobs.get(id))
                .and_then(|j| j.work.clone());
            let complete: HashSet<_> = e
                .dubbing_runs
                .iter()
                .filter(|r| {
                    ["succeeded", "skipped"].contains(&r.status.as_str())
                        || (r.status == "running" && active_work.is_some())
                })
                .flat_map(|r| r.line_ids.iter())
                .collect();
            if let Some(plan) = &e.eta_plan {
                for take in plan.iter().filter(|t| !complete.contains(&t.line_id)) {
                    // Failed separation rows will not be dubbed in this run.
                    if e.spec.separation.is_some()
                        && e.rows
                            .iter()
                            .any(|r| r.line_id == take.line_id && r.status == "failed")
                    {
                        continue;
                    }
                    let measured = if self.project_id.as_deref() == Some(&e.project_id) {
                        take.query
                            .as_ref()
                            .and_then(|q| self.history.as_mut().and_then(|h| h.predict(q)))
                    } else {
                        take.initial_ms
                    };
                    result.push(measured);
                }
            } else {
                // Pre-v0.53 journals have no immutable prediction inputs.
                for row in e.rows.iter().filter(|r| !complete.contains(&r.line_id)) {
                    for _ in 0..e.spec.selection.take_count.unwrap_or(1) {
                        result.push(None);
                    }
                }
            }
            if let Some(work) = active_work {
                result.append(work);
            }
        }
        Some(result)
    }
    pub fn blocking(&self, queue_active: bool) -> Forecast {
        let mut f = Forecast::default();
        if queue_active {
            return f;
        }
        // A separately launched task may already own the gate. Include its
        // known remaining work, or mark that wait unknown, before queued lots.
        for (id, j) in self
            .jobs
            .iter()
            .filter(|(_, j)| j.status == "running" && j.kind != "download")
        {
            if let Some(work) = &j.work {
                f.append(work.clone());
            } else if let Some(step) = &j.step {
                f.append(Forecast {
                    active: Some(Active {
                        job_id: id.clone(),
                        estimated_ms: step.estimated_ms,
                        baseline_elapsed_ms: step.baseline_elapsed_ms,
                    }),
                    ..Forecast::default()
                });
            } else {
                f.push(None);
            }
        }
        f
    }
}
