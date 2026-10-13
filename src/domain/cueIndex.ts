import type { Cue } from './types';
export function cueIndex(cues: Cue[]) {
  const ordered = [...cues].sort((a, b) => a.startMs - b.startMs);
  const ends: number[] = [];
  let maximum = 0;
  for (const cue of ordered) {
    maximum = Math.max(maximum, cue.endMs);
    ends.push(maximum);
  }
  return (ms: number) => {
    let low = 0,
      high = ordered.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (ordered[mid].startMs <= ms) low = mid + 1;
      else high = mid;
    }
    const active: Cue[] = [];
    for (let i = low - 1; i >= 0 && ends[i] > ms; i--)
      if (ordered[i].endMs > ms) active.push(ordered[i]);
    return active.reverse();
  };
}
