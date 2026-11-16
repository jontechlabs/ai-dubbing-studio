use super::*;
use crate::{
    generation_timing::{History, Query},
    work_estimate::{Active, Forecast},
};

pub(super) fn capture(core: &Core, request: &Request) -> Vec<Option<Query>> {
    let guard = core.session.lock().ok();
    let p = guard.as_ref().and_then(|g| g.as_ref()).map(|s| &s.project);
    request
        .items
        .iter()
        .map(|item| {
            p.and_then(|p| {
                let line = p.dialogues.iter().find(|l| l.id == item.request.line_id)?;
                tts::timing_query(p, line, &item.request.options, false).ok()
            })
        })
        .collect()
}
pub(super) fn remaining(
    p: &Project,
    key: &str,
    request: &Request,
    plan: &[Option<Query>],
    current: Option<usize>,
    warm: bool,
) -> Forecast {
    let mut history = History::new(p);
    let mut result = Forecast::default();
    let mut loaded = warm;
    for (index, item) in request
        .items
        .iter()
        .enumerate()
        .filter(|(_, i)| i.status == "pending")
    {
        // The active operation is counted exactly once, then replaced by begin_query.
        if Some(index) == current {
            result.active = Some(Active {
                job_id: key.into(),
                estimated_ms: None,
                baseline_elapsed_ms: 0,
            });
        } else {
            let estimate = plan.get(index).and_then(|q| q.as_ref()).and_then(|q| {
                let mut query = q.clone();
                query.warm_model = loaded && !item.request.options.variant().contains("gguf");
                history.predict(&query)
            });
            result.push(estimate);
        }
        // Future successful takes reuse the lot's session. Errors that unload it
        // are reflected by the next checkpoint's actual is_loaded() value.
        loaded = true;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remaining_counts_each_take_separates_cold_and_warm_and_drops_finished_items() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = super::super::tests::fixture(dir.path(), &["Bonjour", "Bonjour"]);
        let selection = Selection {
            take_count: Some(4),
            scope: "all".into(),
            approved_only: false,
            unapproved_only: false,
            line_ids: vec![],
            force: true,
            options: super::super::tests::options(),
        };
        let (_, items) = plan(&p, dir.path(), &selection).unwrap();
        let mut r = Request {
            take_count: Some(4),
            created_at: None,
            origin_batch_id: None,
            root: dir.path().into(),
            approved_only: false,
            unapproved_only: false,
            project_id: p.id.clone(),
            language: "fr".into(),
            items,
            skipped: 0,
        };
        let cold = tts::timing_query(&p, &p.dialogues[0], &selection.options, false).unwrap();
        let mut warm = cold.clone();
        warm.warm_model = true;
        for (id, q, ms) in [("cold", &cold, 120000), ("warm", &warm, 10000)] {
            let mut t = serde_json::to_value(q).unwrap();
            t["takeId"] = serde_json::json!(id);
            t["elapsedMs"] = serde_json::json!(ms);
            p.generations
                .push(serde_json::json!({"id":id,"kind":"tts","generationTiming":t}));
        }
        let queries = vec![Some(cold); 8];
        let f = remaining(&p, "batch", &r, &queries, None, false);
        assert_eq!(
            (f.pending_ms, f.pending_known, f.pending_unknown),
            (190000, 8, 0)
        );
        r.items[0].status = "succeeded".into();
        r.items[1].status = "failed".into();
        r.items[2].status = "skipped".into();
        let f = remaining(&p, "batch", &r, &queries, Some(3), true);
        assert_eq!(
            (f.pending_ms, f.pending_known, f.pending_unknown),
            (40000, 4, 0)
        );
        assert_eq!(f.active.unwrap().job_id, "batch");
        let f = remaining(&p, "batch", &r, &queries, None, false);
        assert_eq!(f.pending_ms, 160000);
        p.generations.clear();
        let f = remaining(&p, "batch", &r, &queries, None, false);
        assert_eq!(
            (f.pending_ms, f.pending_known, f.pending_unknown),
            (0, 0, 5)
        );
    }
}
