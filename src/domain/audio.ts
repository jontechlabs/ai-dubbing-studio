import type { Project, Track } from './types';
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
  ];
}
export function effectiveGain(track: Track, tracks: Track[], master: number) {
  const solo = tracks.some((item) => item.solo && !item.mute);
  return track.mute || (solo && !track.solo) ? 0 : Math.max(0, Math.min(2, track.gain)) * master;
}
export function editTrack(
  project: Project,
  id: string,
  change: Partial<Pick<Track, 'mute' | 'solo' | 'gain'>>,
) {
  const next = structuredClone(project);
  if (!next.tracks.some((track) => track.id === id) && id === 'original')
    next.tracks.push(audioTracks(project)[0]);
  next.tracks = next.tracks.map((track) => (track.id === id ? { ...track, ...change } : track));
  return next;
}
