import { it, expect } from 'vitest';
import { demoProject, validateProject } from './project';
import {
  audioPatches,
  trackPatches,
  layerGate,
  layerChanges,
  removeTransfer,
  patchGain,
  setAudioSource,
  sourceTrack,
  type AudioPatch,
} from './audioPatch';
import { dubbingMix } from './audio';
import type { Project } from './types';
function fixture() {
  const p = demoProject();
  p.formatVersion = 8;
  p.tracks.push(
    ...(['speech', 'music', 'sfx'] as const).map((role) => ({
      id: role,
      kind: 'audio' as const,
      role,
      path: `stems/${role}.wav`,
      language: 'ja',
      mute: false,
      solo: false,
      gain: 1,
    })),
  );
  return p;
}
function patch(p: Project, id: string, mode: AudioPatch['mode'] = 'add'): AudioPatch {
  return {
    kind: 'audioPatch',
    id,
    operationId: 'operation',
    operation: 'move',
    sourcePath: p.media!.path,
    trackId: 'speech',
    sourceTrackId: 'music',
    startMs: 1000,
    endMs: 2000,
    mode,
    path: mode === 'silence' ? null : `stems/patch-${id}.wav`,
    gain: 1,
  };
}
it('later replacement gates prior layers while a later addition can play above a cut', () => {
  const p = fixture();
  p.generations = [patch(p, 'a'), patch(p, 'b', 'silence'), patch(p, 'c')];
  const layers = trackPatches(p, 'speech');
  expect(layerGate(layers, 1500)).toBe(0);
  expect(layerGate(layers, 1500, 0)).toBe(0);
  expect(layerGate(layers, 1500, 2)).toBe(1);
  expect(layerGate(layers, 2000)).toBe(1);
  expect(layerChanges(p.tracks[1], layers, 0, 3000)).toEqual([
    { timeMs: 1000, gain: 0 },
    { timeMs: 2000, gain: 1 },
  ]);
});
it('removes the whole transfer atomically and adjusts only the selected layer gain', () => {
  const p = fixture();
  p.generations = [patch(p, 'a'), { ...patch(p, 'b', 'silence'), trackId: 'music' }];
  expect(removeTransfer(p, 'operation').generations).toEqual([]);
  expect(audioPatches(patchGain(p, 'a', 0.5))[0].gain).toBe(0.5);
  expect(audioPatches(p)[0].gain).toBe(1);
  expect(validateProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
});
it('defaults the reference to Speech, allows overrides and mutes the chosen replacement track', () => {
  let p = fixture();
  expect(sourceTrack(p)?.id).toBe('speech');
  p = setAudioSource(p, 'referenceTrackId', 'music');
  expect(sourceTrack(p)?.id).toBe('music');
  expect(sourceTrack(p, 'sfx')?.id).toBe('sfx');
  p = setAudioSource(p, 'dubbingSourceTrackId', 'music');
  p.tracks.push({
    id: 'dubbing',
    kind: 'dubbing',
    language: 'fr',
    gain: 1,
    mute: true,
    solo: false,
  });
  const mixed = dubbingMix(p);
  expect(mixed.tracks.find((t) => t.id === 'music')?.mute).toBe(true);
  expect(mixed.tracks.find((t) => t.id === 'speech')?.mute).toBe(false);
  expect(mixed.tracks.find((t) => t.id === 'original')?.mute).toBe(true);
});
it('rejects malformed paths, times, duplicated IDs and format downgrade', () => {
  const p = fixture();
  p.generations = [patch(p, 'a')];
  for (const change of [
    { path: '../private.wav' },
    { startMs: 1000.5 },
    { endMs: 100000 },
    { gain: NaN },
    { trackId: 'dubbing' },
  ]) {
    const bad = structuredClone(p);
    Object.assign(bad.generations[0], change);
    expect(() => validateProject(bad)).toThrow();
  }
  expect(() => validateProject({ ...p, formatVersion: 7 })).toThrow();
  expect(() =>
    validateProject({ ...p, generations: [...p.generations, ...p.generations] }),
  ).toThrow();
});
