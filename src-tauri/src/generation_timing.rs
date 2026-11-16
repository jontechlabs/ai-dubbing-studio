//! Successful take measurements, independent of job retention and wall clocks.
use crate::{domain::Project, jobs, Core};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::Instant;

#[derive(Clone, Debug, Hash, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Query {
    operation: String,
    context_key: String,
    input_units: u64,
    pub warm_model: bool,
}
impl Query {
    pub fn new(operation: &str, context: Value, input_units: u64, warm_model: bool) -> Self {
        Self {
            operation: operation.into(),
            context_key: context_key(operation, context),
            input_units: input_units.clamp(1, 120000),
            warm_model,
        }
    }
    fn timing(&self) -> TakeTiming {
        TakeTiming {
            take_id: "forecast".into(),
            operation: self.operation.clone(),
            context_key: self.context_key.clone(),
            input_units: self.input_units,
            warm_model: self.warm_model,
            elapsed_ms: 1,
        }
    }
}
/// Snapshot only bounded successful measurements, not the whole project/audio.
pub(crate) struct History {
    samples: Project,
    cache: HashMap<Query, Option<u64>>,
}
impl History {
    pub fn new(p: &Project) -> Self {
        let mut samples = Project::new(String::new(), String::new(), String::new());
        samples.generations = p
            .generations
            .iter()
            .rev()
            .take(512)
            .rev()
            .filter_map(|g| {
                let t: TakeTiming =
                    serde_json::from_value(g.get("generationTiming")?.clone()).ok()?;
                (g["kind"] == "tts" && t.validate().is_ok() && g["id"] == t.take_id)
                    .then(|| json!({"id":t.take_id,"kind":"tts","generationTiming":t}))
            })
            .collect();
        Self {
            samples,
            cache: HashMap::new(),
        }
    }
    pub fn predict(&mut self, query: &Query) -> Option<u64> {
        *self.cache.entry(query.clone()).or_insert_with(|| {
            let timing = query.timing();
            if timing.validate().is_err() {
                return None;
            }
            comparable(&self.samples, &timing).0
        })
    }
}

const MAX_MS: u64 = 86_400_000;
pub(crate) fn audio_units(p: &Project, source: &Value) -> u64 {
    p.voice_edits
        .get(source["id"].as_str().unwrap_or_default())
        .and_then(|edit| {
            edit.pieces
                .iter()
                .try_fold(0u64, |sum, piece| sum.checked_add(piece.duration_ms))
        })
        .or_else(|| source["durationMs"].as_u64())
        .unwrap_or(1)
        .clamp(1, 120000)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeTiming {
    pub take_id: String,
    pub operation: String,
    pub elapsed_ms: u64,
    pub input_units: u64,
    pub warm_model: bool,
    pub context_key: String,
}
impl TakeTiming {
    pub fn validate(&self) -> Result<(), String> {
        if self.take_id.is_empty()
            || self.take_id.len() > 128
            || !["tts", "voiceConversion", "prosody"].contains(&self.operation.as_str())
            || !(1..=MAX_MS).contains(&self.elapsed_ms)
            || !(1..=120000).contains(&self.input_units)
            || self.context_key.len() != 64
            || !self.context_key.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err("INVALID_GENERATION".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub operation: String,
    pub estimated_ms: Option<u64>,
    pub baseline_elapsed_ms: u64,
    pub sample_count: usize,
}
pub(crate) struct Measurement {
    start: Instant,
    timing: TakeTiming,
}
impl Measurement {
    pub fn finish(self, take_id: &str) -> Value {
        let mut timing = self.timing;
        timing.take_id = take_id.into();
        timing.elapsed_ms =
            (self.start.elapsed().as_millis().min(u128::from(MAX_MS)) as u64).max(1);
        json!(timing)
    }
}
fn normalized(mut value: Value) -> Value {
    match &mut value {
        Value::Object(object) => {
            for key in ["seed", "generationId", "referenceId", "characterId"] {
                object.remove(key);
            }
            for v in object.values_mut() {
                *v = normalized(v.take());
            }
        }
        Value::Array(items) => {
            for v in items {
                *v = normalized(v.take());
            }
        }
        _ => {}
    }
    value
}
fn context_key(operation: &str, context: Value) -> String {
    // Hash the local machine identity, never store the computer/user name in a project.
    let machine = json!([
        std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_default(),
        std::env::var("PROCESSOR_IDENTIFIER").unwrap_or_default(),
        std::env::consts::OS,
        std::env::consts::ARCH,
    ]);
    format!(
        "{:x}",
        Sha256::digest(
            json!([1, machine, operation, normalized(context)])
                .to_string()
                .as_bytes()
        )
    )
}
fn comparable(p: &Project, timing: &TakeTiming) -> (Option<u64>, usize) {
    let mut samples: Vec<_> = p
        .generations
        .iter()
        .rev()
        .take(512)
        .filter_map(|g| {
            if g["kind"] != "tts" {
                return None;
            }
            let item: TakeTiming =
                serde_json::from_value(g.get("generationTiming")?.clone()).ok()?;
            if item.validate().is_err()
                || g["id"].as_str() != Some(item.take_id.as_str())
                || item.operation != timing.operation
                || item.context_key != timing.context_key
                || item.warm_model != timing.warm_model
                || item.input_units * 3 < timing.input_units * 2
                || item.input_units * 2 > timing.input_units * 3
            {
                return None;
            }
            Some((
                item.input_units.abs_diff(timing.input_units),
                item.elapsed_ms,
            ))
        })
        .collect();
    // Similar-sized utterances avoid scaling the fixed model loading cost by text length.
    samples.sort_by_key(|s| s.0);
    samples.truncate(5);
    let mut durations: Vec<_> = samples.iter().map(|s| s.1).collect();
    durations.sort_unstable();
    (durations.get(durations.len() / 2).copied(), durations.len())
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn begin<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    key: &str,
    p: &Project,
    operation: &str,
    context: Value,
    input_units: u64,
    warm_model: bool,
) -> Measurement {
    begin_query(
        core,
        app,
        key,
        p,
        Query::new(operation, context, input_units, warm_model),
    )
}
pub(crate) fn begin_query<R: tauri::Runtime>(
    core: &Core,
    app: &tauri::AppHandle<R>,
    key: &str,
    p: &Project,
    query: Query,
) -> Measurement {
    let start = Instant::now();
    let mut timing = query.timing();
    timing.take_id.clear();
    let (estimated_ms, sample_count) = comparable(p, &timing);
    let baseline = core
        .jobs
        .lock()
        .ok()
        .and_then(|jobs| jobs.get(key).and_then(|j| j.snapshot().timing))
        .map_or(0, |t| t.elapsed_ms);
    jobs::update(core, app, key, |j| {
        j.estimate = Some(Estimate {
            operation: timing.operation.clone(),
            estimated_ms,
            baseline_elapsed_ms: baseline,
            sample_count,
        });
        if let Some(work) = j.work_estimate.as_mut() {
            work.active = Some(crate::work_estimate::Active {
                job_id: key.into(),
                estimated_ms,
                baseline_elapsed_ms: baseline,
            });
        }
    });
    Measurement { start, timing }
}
pub(crate) fn validate(g: &Value) -> Result<(), String> {
    if let Some(value) = g.get("generationTiming") {
        serde_json::from_value::<TakeTiming>(value.clone())
            .map_err(|_| "INVALID_GENERATION")?
            .validate()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(key: &str, units: u64, ms: u64, warm: bool) -> TakeTiming {
        TakeTiming {
            take_id: "measured".into(),
            operation: "tts".into(),
            elapsed_ms: ms,
            input_units: units,
            warm_model: warm,
            context_key: key.into(),
        }
    }
    #[test]
    fn estimates_use_nearby_successful_measurements_and_separate_resident_models() {
        let key = "a".repeat(64);
        let mut p = Project::new("Timing".into(), "ja".into(), "fr".into());
        let r = record(&key, 40, 1000, false);
        for item in [
            record(&key, 40, 10000, false),
            record(&key, 42, 12000, false),
            record(&key, 39, 11000, false),
            record(&key, 40, 900000, true),
            record(&"b".repeat(64), 40, 800000, false),
            record(&key, 200, 700000, false),
            record(&key, 40, 0, false),
        ] {
            p.generations
                .push(json!({"kind":"tts","id":"measured","generationTiming":item}));
        }
        p.generations.push(json!({"kind":"tts"}));
        assert_eq!(comparable(&p, &r), (Some(11000), 3));
        assert_eq!(
            comparable(&p, &record(&key, 40, 1, true)),
            (Some(900000), 1)
        );
        assert_eq!(comparable(&p, &record(&key, 5, 1, false)), (None, 0));
    }
    #[test]
    fn timing_is_optional_but_new_records_are_bounded_and_do_not_mix_devices() {
        assert!(validate(&json!({})).is_ok());
        let r = record(&"c".repeat(64), 20, 1234, false);
        assert!(validate(&json!({"generationTiming":r})).is_ok());
        for value in [json!(null), json!({}), json!({"elapsedMs":-1})] {
            assert!(validate(&json!({"generationTiming":value})).is_err());
        }
        assert_eq!(
            context_key(
                "tts",
                json!({"seed":1,"referenceId":"one","options":{"temperature":0.7}})
            ),
            context_key(
                "tts",
                json!({"seed":2,"referenceId":"two","options":{"temperature":0.7}})
            )
        );
        assert_ne!(
            context_key("tts", json!({"device":"cpu"})),
            context_key("tts", json!({"device":"cuda:0"}))
        );
    }
}
