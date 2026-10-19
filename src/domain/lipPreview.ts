import type { LipVideo } from './inpaint';

// Sorted, enabled and non-overlapping. This per-frame search is bounded even
// on a project with thousands of retouched dialogues.
export function lipPreviewPlan(edits: LipVideo[], timeMs: number, lookahead = 5000) {
  let low = 0,
    high = edits.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (edits[mid].startMs <= timeMs) low = mid + 1;
    else high = mid;
  }
  const previous = edits[low - 1];
  const active = previous && timeMs < previous.startMs + previous.durationMs ? previous : undefined;
  const future = edits[low];
  const next = future && future.startMs - timeMs <= lookahead ? future : undefined;
  return { active, next };
}
