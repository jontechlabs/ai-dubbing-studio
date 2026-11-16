//! Remaining work, without subtracting elapsed time from future operations.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Active {
    pub job_id: String,
    pub estimated_ms: Option<u64>,
    pub baseline_elapsed_ms: u64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Forecast {
    pub pending_ms: u64,
    pub pending_known: usize,
    pub pending_unknown: usize,
    pub active: Option<Active>,
}
impl Forecast {
    pub fn push(&mut self, ms: Option<u64>) {
        if let Some(ms) = ms.filter(|ms| *ms > 0 && *ms <= 86_400_000) {
            self.pending_ms = self.pending_ms.saturating_add(ms);
            self.pending_known += 1;
        } else {
            self.pending_unknown += 1;
        }
    }
    pub fn append(&mut self, other: Self) {
        if other.count() == 0 {
            return;
        }
        self.pending_ms = self.pending_ms.saturating_add(other.pending_ms);
        self.pending_known += other.pending_known;
        self.pending_unknown += other.pending_unknown;
        // The GPU gate/FIFO permits one active operation. Treat an unexpected
        // additional active operation as unknown rather than inventing overlap.
        if other.active.is_some() {
            if self.active.is_none() {
                self.active = other.active;
            } else {
                self.pending_unknown += 1;
            }
        }
    }
    pub fn count(&self) -> usize {
        self.pending_known + self.pending_unknown + usize::from(self.active.is_some())
    }
}
