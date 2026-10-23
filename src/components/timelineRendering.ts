// Display-only limits: these never change media, subtitle or dubbing timings.
export const MAX_TIMELINE_WINDOW_MS = 120_000;
export function timelineZoomBounds(duration: number, viewport: number) {
  const maxZoom = Math.max(1, Math.min(duration / 500, 8_000_000 / viewport));
  return { minZoom: Math.min(maxZoom, Math.max(1, duration / MAX_TIMELINE_WINDOW_MS)), maxZoom };
}

// Build once per waveform. Each level retains the exact maximum of two bins.
// Drawing or scrolling then queries only the bins needed for screen pixels.
export function peakEnvelope(peaks: number[]) {
  const levels = [peaks];
  while (levels.at(-1)!.length > 1) {
    const previous = levels.at(-1)!;
    const next: number[] = [];
    for (let i = 0; i < previous.length; i += 2)
      next.push(Math.max(previous[i], previous[i + 1] ?? 0));
    levels.push(next);
  }
  return { levels, maximum: Math.max(0.001, levels.at(-1)![0] ?? 0) };
}
export function peakInRange(levels: number[][], start: number, end: number) {
  let from = Math.max(0, Math.floor(start));
  const to = Math.min(levels[0].length, Math.ceil(end));
  let peak = 0;
  while (from < to) {
    let level = 0;
    // Only consume complete aligned bins; no peak leaks across a pixel edge.
    while (
      level + 1 < levels.length &&
      from % 2 ** (level + 1) === 0 &&
      from + 2 ** (level + 1) <= to
    )
      level++;
    peak = Math.max(peak, levels[level][from / 2 ** level]);
    from += 2 ** level;
  }
  return peak;
}
