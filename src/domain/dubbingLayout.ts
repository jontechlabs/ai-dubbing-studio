/** Compact visual rows per logical track, independent of separator output IDs. */
export function dubbingLayout(
  clips: {
    generation: { id: string };
    laneId: string;
    startMs: number;
    endMs: number;
    lane?: number;
  }[],
) {
  const rows = new Map<string, number>(),
    counts = new Map<string, number>();
  const ends = new Map<string, number[]>();
  for (const clip of [...clips].sort(
    (a, b) =>
      a.startMs - b.startMs ||
      (a.lane ?? 0) - (b.lane ?? 0) ||
      a.endMs - b.endMs ||
      a.generation.id.localeCompare(b.generation.id),
  )) {
    const track = ends.get(clip.laneId) ?? [];
    let row = track.findIndex((end) => end <= clip.startMs);
    if (row < 0) row = track.length;
    track[row] = clip.endMs;
    ends.set(clip.laneId, track);
    rows.set(clip.generation.id, row);
    counts.set(clip.laneId, track.length);
  }
  return { rows, counts };
}
