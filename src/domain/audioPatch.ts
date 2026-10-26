import type { Project, Track } from './types';
import { audioTracks, regionGain, gainChanges } from './audio';
export interface AudioPatch {
  [key: string]: unknown;
  kind: 'audioPatch';
  id: string;
  operationId: string;
  operation: 'copy' | 'move' | 'swap' | 'effects' | 'separation';
  sourcePath: string;
  trackId: string;
  sourceTrackId: string;
  startMs: number;
  endMs: number;
  mode: 'add' | 'replace' | 'silence';
  path: string | null;
  gain: number;
}
export interface TransferOptions {
  sourceTrackId: string;
  targetTrackId: string;
  startMs: number;
  endMs: number;
  operation: 'copy' | 'move' | 'swap';
}
export function audioPatches(p: Project): AudioPatch[] {
  return p.generations.filter((g) => g.kind === 'audioPatch') as unknown as AudioPatch[];
}
export function trackPatches(p: Project, id: string) {
  return audioPatches(p).filter((e) => e.trackId === id && e.sourcePath === p.media?.path);
}
export function layerGate(patches: AudioPatch[], time: number, index = -1) {
  return patches.some(
    (e, i) => i > index && e.mode !== 'add' && time >= e.startMs && time < e.endMs,
  )
    ? 0
    : 1;
}
export function layerChanges(
  track: Track,
  patches: AudioPatch[],
  start: number,
  end: number,
  index = -1,
) {
  const times = new Set(gainChanges(track, start, end).map((p) => p.timeMs));
  for (const e of patches)
    for (const time of [e.startMs, e.endMs]) if (time > start && time <= end) times.add(time);
  return [...times]
    .sort((a, b) => a - b)
    .map((timeMs) => ({
      timeMs,
      gain: regionGain(track, timeMs) * layerGate(patches, timeMs, index),
    }));
}
export function sourceTrack(p: Project, requested?: string) {
  const tracks = audioTracks(p).filter((t) => t.kind !== 'dubbing');
  const id = requested && requested !== 'auto' ? requested : p.modelPreferences?.referenceTrackId;
  return id && id !== 'auto'
    ? tracks.find((t) => t.id === id)
    : (tracks.find((t) => t.role === 'speech') ?? tracks[0]);
}
export function setAudioSource(
  p: Project,
  key: 'referenceTrackId' | 'dubbingSourceTrackId',
  id: string,
) {
  if (id !== 'auto' && !audioTracks(p).some((t) => t.kind !== 'dubbing' && t.id === id))
    throw Error('INVALID_AUDIO_TRANSFER');
  return {
    ...p,
    formatVersion: Math.max(8, p.formatVersion),
    modelPreferences: { ttsProviderId: null, ...p.modelPreferences, [key]: id },
  };
}
export function removeTransfer(p: Project, operationId: string): Project {
  return {
    ...p,
    generations: p.generations.filter(
      (e) => e.kind !== 'audioPatch' || e.operationId !== operationId,
    ),
  };
}
export function patchGain(p: Project, id: string, gain: number): Project {
  if (!Number.isFinite(gain) || gain < 0 || gain > 2) throw Error('INVALID_AUDIO_TRANSFER');
  return {
    ...p,
    generations: p.generations.map((e) =>
      e.kind === 'audioPatch' && e.id === id ? { ...e, gain } : e,
    ),
  };
}
export function validateAudioPatches(p: Project) {
  const patches = audioPatches(p);
  if (patches.length > 128) throw Error('AUDIO_TRANSFER_LIMIT');
  const safe = (s: unknown) =>
    typeof s === 'string' && !!s && !s.includes('..') && !/[\\:]/.test(s) && !s.startsWith('/');
  for (const e of patches)
    if (
      p.formatVersion < 8 ||
      !e.id ||
      !e.operationId ||
      !e.trackId ||
      e.trackId === 'dubbing' ||
      !e.sourceTrackId ||
      !safe(e.sourcePath) ||
      !Number.isSafeInteger(e.startMs) ||
      !Number.isSafeInteger(e.endMs) ||
      e.startMs < 0 ||
      e.endMs > 86400000 ||
      e.endMs - e.startMs < 10 ||
      e.endMs - e.startMs > (e.operation === 'effects' ? 120000 : 60000) ||
      !['copy', 'move', 'swap', 'effects', 'separation'].includes(e.operation) ||
      (e.operation === 'separation' && p.formatVersion < 20) ||
      (e.operation === 'effects' && p.formatVersion < 18) ||
      !['add', 'replace', 'silence'].includes(e.mode) ||
      !Number.isFinite(e.gain) ||
      e.gain < 0 ||
      e.gain > 2 ||
      p.generations.filter((g) => g.id === e.id).length !== 1 ||
      (e.mode === 'silence'
        ? e.path != null
        : !safe(e.path) || !e.path?.startsWith('stems/patch-') || !e.path.endsWith('.wav'))
    )
      throw Error('INVALID_AUDIO_TRANSFER');
  for (const id of [p.modelPreferences?.referenceTrackId, p.modelPreferences?.dubbingSourceTrackId])
    if (id != null && (typeof id !== 'string' || !id || id.length > 128))
      throw Error('INVALID_AUDIO_TRANSFER');
}
