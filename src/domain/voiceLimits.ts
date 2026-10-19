export const MAX_VOICE_DURATION_MS = 120000;

// Reserve one millisecond for every remaining piece, including very short
// pieces after a split. Independent proportional rounding can create zeros.
export function fitPieceDurations(durations: number[], target: number) {
  if (!Number.isSafeInteger(target) || target < durations.length || target > MAX_VOICE_DURATION_MS)
    throw Error('VOICE_DURATION_OUT_OF_RANGE');
  const total = durations.reduce((sum, n) => sum + n, 0);
  let offset = 0,
    assigned = 0;
  return durations.map((duration, i) => {
    offset += duration;
    const end = Math.max(
      assigned + 1,
      Math.min(target - (durations.length - i - 1), Math.round((offset / total) * target)),
    );
    const value = end - assigned;
    assigned = end;
    return value;
  });
}

// A move preserves the audible duration. Snap to the closest free placement,
// rather than shrinking this voice or the voice underneath the pointer.
export function freeVoiceStart(
  requested: number,
  duration: number,
  movieEnd: number,
  occupied: { startMs: number; endMs: number }[],
  minStart = 0,
  maxStart = movieEnd - duration,
) {
  let end = 0;
  const candidates: number[] = [];
  const gap = (left: number, right: number) => {
    const min = Math.max(minStart, left),
      max = Math.min(maxStart, right - duration);
    if (min <= max) candidates.push(Math.max(min, Math.min(max, requested)));
  };
  for (const clip of [...occupied].sort((a, b) => a.startMs - b.startMs)) {
    gap(end, clip.startMs);
    end = Math.max(end, clip.endMs);
  }
  gap(end, movieEnd);
  if (!candidates.length) throw Error('VOICE_EDIT_NO_ROOM');
  return candidates.reduce((best, value) =>
    Math.abs(value - requested) < Math.abs(best - requested) ? value : best,
  );
}
