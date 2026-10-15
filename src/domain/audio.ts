import type { AudioRegion, Project, Track } from './types';
export function audioTracks(project: Project): Track[] {
  const original = project.tracks.find((track) => track.kind === 'original') ?? {
    id: 'original',
    kind: 'original' as const,
    language: project.languages.source,
    mute: false,
    solo: false,
    gain: 1,
  };
  return [
    original,
    ...project.tracks.filter(
      (track) =>
        track.kind === 'audio' && (!track.sourcePath || track.sourcePath === project.media?.path),
    ),
    ...(project.generations.some((g) => g.kind === 'tts') ||
    project.tracks.some((t) => t.kind === 'dubbing')
      ? [
          project.tracks.find((t) => t.kind === 'dubbing') ?? {
            id: 'dubbing',
            kind: 'dubbing' as const,
            language: project.languages.target,
            mute: true,
            solo: false,
            gain: 1,
          },
        ]
      : []),
  ];
}
export function effectiveGain(track: Track, tracks: Track[], master: number, timeMs?: number) {
  const solo = tracks.some((item) => item.solo && !item.mute);
  return track.mute || (solo && !track.solo)
    ? 0
    : Math.max(0, Math.min(2, track.gain)) *
        master *
        (timeMs === undefined ? 1 : regionGain(track, timeMs));
}
export function regionGain(track: Track, timeMs: number) {
  if (track.regionsEnabled === false || !track.regions?.length) return 1;
  let low = 0,
    high = track.regions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (track.regions[middle].startMs <= timeMs) low = middle + 1;
    else high = middle;
  }
  const region = track.regions[low - 1];
  return region && timeMs < region.endMs ? (region.mute ? 0 : region.gain) : 1;
}
export function gainChanges(
  track: Track,
  startMs: number,
  endMs: number,
): { timeMs: number; gain: number }[] {
  if (track.regionsEnabled === false) return [];
  const times = new Set<number>();
  for (const region of track.regions ?? []) {
    if (region.startMs > endMs) break;
    if (region.startMs > startMs && region.startMs <= endMs) times.add(region.startMs);
    if (region.endMs > startMs && region.endMs <= endMs) times.add(region.endMs);
  }
  return [...times]
    .sort((a, b) => a - b)
    .map((timeMs) => ({ timeMs, gain: regionGain(track, timeMs) }));
}
export function setAudioRegions(
  project: Project,
  trackId: string,
  regions: AudioRegion[],
  enabled = true,
): Project {
  let next = editTrack(project, trackId, {});
  const track = audioTracks(next).find((track) => track.id === trackId);
  if (!track || !next.media) throw new Error('INVALID_AUDIO_REGION');
  const limit = track.durationMs ?? next.media.durationMs;
  const sorted = [...regions].sort((a, b) => a.startMs - b.startMs);
  if (sorted.length > 10000) throw new Error('INVALID_AUDIO_REGION');
  const ids = new Set<string>();
  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i];
    if (
      !item.id ||
      ids.has(item.id) ||
      !Number.isSafeInteger(item.startMs) ||
      !Number.isSafeInteger(item.endMs) ||
      item.startMs < 0 ||
      item.endMs <= item.startMs ||
      item.endMs > limit ||
      !Number.isFinite(item.gain) ||
      item.gain < 0 ||
      item.gain > 2 ||
      typeof item.mute !== 'boolean' ||
      (i > 0 && sorted[i - 1].endMs > item.startMs)
    )
      throw new Error('INVALID_AUDIO_REGION');
    ids.add(item.id);
  }
  next = { ...next, formatVersion: Math.max(4, next.formatVersion) };
  next.tracks = next.tracks.map((item) =>
    item.id === trackId ? { ...item, regions: sorted, regionsEnabled: enabled } : item,
  );
  return next;
}
// A newer range replaces the overlap and retains the unaffected left/right pieces.
export function paintAudioRegion(
  project: Project,
  trackId: string,
  range: Omit<AudioRegion, 'id'>,
  editingId?: string,
): Project {
  const track = audioTracks(project).find((item) => item.id === trackId);
  if (!track) throw new Error('INVALID_AUDIO_REGION');
  const regions: AudioRegion[] = [];
  for (const old of track.regions ?? []) {
    if (old.id === editingId) continue;
    if (old.endMs <= range.startMs || old.startMs >= range.endMs) {
      regions.push({ ...old });
      continue;
    }
    if (old.startMs < range.startMs) regions.push({ ...old, endMs: range.startMs });
    if (old.endMs > range.endMs)
      regions.push({ ...old, id: crypto.randomUUID(), startMs: range.endMs });
  }
  regions.push({ ...range, id: editingId ?? crypto.randomUUID() });
  return setAudioRegions(project, trackId, regions);
}
export function setAllAudio(project: Project, audible: boolean, trackId?: string) {
  let next = project;
  for (const track of audioTracks(project)) next = editTrack(next, track.id, {});
  const ids = new Set(
    audioTracks(next)
      .filter((track) => !trackId || track.id === trackId)
      .map((track) => track.id),
  );
  next.tracks = next.tracks.map((track) =>
    ids.has(track.id)
      ? {
          ...track,
          mute: !audible,
          solo: false,
          ...(audible && track.regions?.length ? { regionsEnabled: false } : {}),
        }
      : track,
  );
  return next;
}
export function enableAudioRegions(project: Project, trackId?: string) {
  const next = structuredClone(project);
  next.tracks = next.tracks.map((track) =>
    (!trackId || track.id === trackId) && track.regions?.length
      ? { ...track, regionsEnabled: true }
      : track,
  );
  return next;
}
export function editTrack(
  project: Project,
  id: string,
  change: Partial<Pick<Track, 'mute' | 'solo' | 'gain'>>,
) {
  const next = structuredClone(project);
  if (!next.tracks.some((track) => track.id === id)) {
    const track = audioTracks(project).find((track) => track.id === id);
    if (track) next.tracks.push(track);
  }
  if (next.tracks.some((t) => t.kind === 'dubbing'))
    next.formatVersion = Math.max(6, next.formatVersion);
  next.tracks = next.tracks.map((track) => (track.id === id ? { ...track, ...change } : track));
  return next;
}
export function dubbingMix(project: Project) {
  let next = editTrack(project, 'dubbing', { mute: false, solo: false });
  next = editTrack(next, 'original', { mute: true, solo: false });
  next.tracks = next.tracks.map((t) =>
    t.kind === 'audio' ? { ...t, mute: t.role === 'speech', solo: false } : t,
  );
  return next;
}
export function trackLabel(track: Track) {
  return track.kind === 'original'
    ? 'original'
    : track.kind === 'dubbing'
      ? 'dubbingTrack'
      : `stem.${track.role}`;
}
