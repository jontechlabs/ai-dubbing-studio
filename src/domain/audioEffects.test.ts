import { expect, it } from 'vitest';
import {
  audioEffectsCatalog,
  defaultEffect,
  validateEffects,
  removeEffectsTrack,
  validateEffectsProject,
} from './audioEffects';
import { demoProject, validateProject } from './project';
import { editTrack, effectiveGain, paintAudioRegion, audioTracks, dubbingMix } from './audio';

it('validates every shipped preset and rejects unknown parameters, invalid values and long chains', () => {
  expect(audioEffectsCatalog.effects).toHaveLength(20);
  expect(audioEffectsCatalog.presets).toHaveLength(12);
  for (const p of audioEffectsCatalog.presets) validateEffects(p.chain);
  expect(() =>
    validateEffects([{ ...defaultEffect('pitch'), parameters: { semitones: 12.1 } }]),
  ).toThrow('INVALID_AUDIO_EFFECTS');
  expect(() =>
    validateEffects([{ ...defaultEffect('pitch'), parameters: { semitones: NaN } }]),
  ).toThrow('INVALID_AUDIO_EFFECTS');
  expect(() => validateEffects([{ ...defaultEffect('echo'), parameters: { script: 1 } }])).toThrow(
    'INVALID_AUDIO_EFFECTS',
  );
  expect(() => validateEffects(Array.from({ length: 9 }, () => defaultEffect('echo')))).toThrow(
    'INVALID_AUDIO_EFFECTS',
  );
});
it('keeps track gain independent from region automation, supports 400% and upgrades the project safely', () => {
  const base = paintAudioRegion(demoProject(), 'original', {
    startMs: 1000,
    endMs: 2000,
    gain: 0.5,
    mute: false,
  });
  const p = editTrack(base, 'original', { gain: 4 });
  const tracks = audioTracks(p),
    track = tracks[0];
  expect(p.formatVersion).toBe(18);
  expect(effectiveGain(track, tracks, 1, 1500)).toBe(2);
  expect(effectiveGain(track, tracks, 1, 2500)).toBe(4);
  expect(base.tracks[0].gain).toBe(1);
  validateProject(p);
  expect(() => editTrack(p, 'original', { gain: 4.01 })).toThrow('INVALID_PROJECT');
  expect(() => editTrack(p, 'original', { gain: Infinity })).toThrow('INVALID_PROJECT');
  const old = { ...p, formatVersion: 17 };
  expect(() => validateProject(old)).toThrow('INVALID_PROJECT');
});
function processed() {
  const p = editTrack(demoProject(), 'original', { mute: true });
  p.formatVersion = 18;
  p.tracks.push({
    id: 'fx',
    kind: 'audio',
    name: 'Audio · FX',
    language: 'ja',
    gain: 1,
    mute: false,
    solo: false,
    path: 'stems/patch-fx.wav',
    sourcePath: p.media!.path,
    durationMs: p.media!.durationMs,
  });
  p.generations.push({
    id: 'fx',
    kind: 'audioEffects',
    trackId: 'fx',
    sourceTrackId: 'original',
    path: 'stems/patch-fx.wav',
    effectsSourcePath: 'stems/patch-fx-dry.wav',
    sourceMuteBefore: false,
    replaceInMix: true,
    effects: [defaultEffect('pitch')],
  });
  return p;
}
it('removes a processed copy and restores the previous mute state without touching source media', () => {
  const p = processed();
  validateEffectsProject(p);
  const next = removeEffectsTrack(p, 'fx');
  expect(next.tracks.some((t) => t.id === 'fx')).toBe(false);
  expect(next.tracks.find((t) => t.id === 'original')!.mute).toBe(false);
  expect(next.media).toEqual(p.media);
  expect(p.tracks).toHaveLength(next.tracks.length + 1);
});
it('preparing the dubbing mix keeps an active processed stem from doubling its dry source', () => {
  const p = processed();
  p.tracks[0].kind = 'audio';
  p.tracks[0].role = 'music';
  p.tracks[0].path = 'stems/music.wav';
  p.tracks[0].sourcePath = p.media!.path;
  const next = dubbingMix(p);
  expect(next.tracks.find((t) => t.id === 'original')!.mute).toBe(true);
  expect(next.tracks.find((t) => t.id === 'fx')!.mute).toBe(false);
});
it('protects effect source paths and copies that are still used as another effect source', () => {
  const p = processed();
  p.generations.push({ id: 'child', kind: 'audioEffects', sourceTrackId: 'fx' });
  expect(() => removeEffectsTrack(p, 'fx')).toThrow('AUDIO_EFFECTS_SOURCE_IN_USE');
  const bad = processed();
  const row = bad.generations[0] as { [key: string]: unknown };
  row.effectsSourcePath = '../outside.wav';
  expect(() => validateEffectsProject(bad)).toThrow('INVALID_AUDIO_EFFECTS');
});
