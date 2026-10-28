import { it, expect } from 'vitest';
import { demoProject, validateProject } from './project';
import { defaultVoiceSettings, deleteGeneration } from './tts';
import { dubbingClips, resizeDubbing, mixReport } from './mix';
import {
  editVoice,
  editDuration,
  voicePlan,
  resetVoiceEdit,
  setVoiceOutputGain,
} from './voiceEdit';
import { rebaseProject } from './rebase';
import type { Generation } from './types';
import { envelopeLevel } from './voiceEnvelope';
import { defaultEffect } from './audioEffects';
function fixture() {
  const p = demoProject();
  p.formatVersion = 5;
  const line = p.dialogues[0];
  line.selectedGenerationIds.fr = 'take';
  p.generations = [
    {
      kind: 'tts',
      id: 'take',
      dialogueId: line.id,
      providerId: 'cosyvoice3',
      modelId: 'cosy3-official',
      path: 'generations/take.wav',
      createdAt: new Date().toISOString(),
      sourcePath: p.media!.path,
      startMs: line.startMs,
      endMs: line.endMs,
      text: 'Bonjour',
      language: 'fr',
      characterId: null,
      durationMs: 2000,
      sampleRate: 24000,
      options: { ...defaultVoiceSettings },
      referenceTranscript: 'Hello',
      device: 'cpu',
      deviceName: 'CPU',
      peakVramMb: 0,
      inputHash: 'fixture',
    } satisfies Generation,
  ];
  return p;
}
it('changes whole-take output gain without rewriting takes, local edits, effects, timing or fades', () => {
  let p = editVoice(fixture(), 'take', 300, 900, {
    kind: 'effects',
    effects: [defaultEffect('echo')],
  });
  p = editVoice(p, 'take', 300, 900, { kind: 'gain', gain: 0.7 });
  const before = structuredClone(p),
    next = setVoiceOutputGain(p, 'take', 1.75);
  expect(next.formatVersion).toBe(22);
  validateProject(next);
  expect(next.generations).toEqual(before.generations);
  expect(next.dubbingTiming).toEqual(before.dubbingTiming);
  expect(next.voiceEdits!.take.pieces).toEqual(before.voiceEdits!.take.pieces);
  const edited = editVoice(next, 'take', 300, 900, { kind: 'stretch', durationMs: 750 });
  expect(edited.voiceEdits!.take.outputGain).toBe(1.75);
  validateProject(edited);
  expect(setVoiceOutputGain(next, 'take', 1).voiceEdits!.take.outputGain).toBeUndefined();
  expect(setVoiceOutputGain(next, 'take', 0).voiceEdits!.take.outputGain).toBe(0);
  expect(validateProject(JSON.parse(JSON.stringify(next))).voiceEdits!.take.outputGain).toBe(1.75);
  for (const bad of [-0.1, 4.01, NaN, Infinity])
    expect(() => setVoiceOutputGain(next, 'take', bad)).toThrow('INVALID_OUTPUT_GAIN');
  expect(() => validateProject({ ...next, formatVersion: 21 })).toThrow('INVALID_OUTPUT_GAIN');
  expect(p).toEqual(before);
});
it('replaces effects on a selected range and preserves them through gain, split and stretch edits', () => {
  const base = fixture();
  const pitch = defaultEffect('pitch');
  pitch.parameters.semitones = 3;
  let p = editVoice(base, 'take', 400, 1200, { kind: 'effects', effects: [pitch] });
  expect(p.formatVersion).toBe(18);
  validateProject(p);
  expect(p.voiceEdits!.take.pieces[1].effects![0].parameters.semitones).toBe(3);
  p = editVoice(p, 'take', 400, 1200, { kind: 'gain', gain: 0.7 });
  p = editVoice(p, 'take', 400, 1200, { kind: 'stretch', durationMs: 1000 });
  expect(p.voiceEdits!.take.pieces[1].effects![0].parameters.semitones).toBe(3);
  const next = editVoice(p, 'take', 400, 1400, {
    kind: 'effects',
    effects: [{ ...pitch, parameters: { semitones: 6 } }],
  });
  expect(next.voiceEdits!.take.pieces[1].effects).toHaveLength(1);
  expect(next.voiceEdits!.take.pieces[1].effects![0].parameters.semitones).toBe(6);
  expect(base.voiceEdits).toBeUndefined();
  expect(next.generations).toEqual(base.generations);
});
it('removes selected effects without merging adjacent ranges that still have different effects', () => {
  let p = editVoice(fixture(), 'take', 0, 1000, {
    kind: 'effects',
    effects: [defaultEffect('echo')],
  });
  p = editVoice(p, 'take', 500, 1500, { kind: 'effects', effects: [] });
  validateProject(p);
  expect(p.voiceEdits!.take.pieces[0].effects).toHaveLength(1);
  expect(p.voiceEdits!.take.pieces.slice(1).every((piece) => !piece.effects?.length)).toBe(true);
  const old = { ...p, formatVersion: 17 };
  expect(() => validateProject(old)).toThrow('INVALID_AUDIO_EFFECTS');
});
it('applies adjustable fades to a selection without changing duration or original files', () => {
  const base = fixture(),
    p = editVoice(base, 'take', 500, 1500, { kind: 'fade', fadeInMs: 100, fadeOutMs: 200 });
  const envelope = p.voiceEdits!.take.pieces[1].envelope!;
  expect(p.formatVersion).toBe(12);
  expect(editDuration(p.voiceEdits!.take)).toBe(2000);
  expect(envelopeLevel(envelope, 0)).toBe(0);
  expect(envelopeLevel(envelope, 50)).toBe(0.5);
  expect(envelopeLevel(envelope, 900)).toBe(0.5);
  expect(envelopeLevel(envelope, 1000)).toBe(0);
  expect(validateProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
  expect(p.generations).toEqual(base.generations);
  const bad = structuredClone(p);
  bad.formatVersion = 11;
  expect(() => validateProject(bad)).toThrow('INVALID_VOICE_EDIT');
});
it('keeps one continuous fade across existing split and gain boundaries', () => {
  let p = editVoice(fixture(), 'take', 500, 1000, { kind: 'gain', gain: 0.5 });
  p = editVoice(p, 'take', 0, 2000, { kind: 'fade', fadeInMs: 1000, fadeOutMs: 500 });
  const pieces = p.voiceEdits!.take.pieces;
  expect(envelopeLevel(pieces[0].envelope, 500)).toBe(0.5);
  expect(envelopeLevel(pieces[1].envelope, 0)).toBe(0.5);
  expect(envelopeLevel(pieces[1].envelope, 500)).toBe(1);
  expect(envelopeLevel(pieces[2].envelope, 1000)).toBe(0);
});
it('preserves fade levels when splitting, deleting and stretching an already faded range', () => {
  let p = editVoice(fixture(), 'take', 0, 2000, { kind: 'fade', fadeInMs: 1000, fadeOutMs: 500 });
  p = editVoice(p, 'take', 250, 750, { kind: 'gain', gain: 0.5 });
  const middle = p.voiceEdits!.take.pieces[1];
  expect(envelopeLevel(middle.envelope, 0)).toBe(0.25);
  expect(envelopeLevel(middle.envelope, 500)).toBe(0.75);
  p = editVoice(p, 'take', 250, 750, { kind: 'stretch', durationMs: 1000 });
  expect(envelopeLevel(p.voiceEdits!.take.pieces[1].envelope, 500)).toBe(0.5);
  p = editVoice(p, 'take', 0, 250, { kind: 'delete' });
  expect(envelopeLevel(p.voiceEdits!.take.pieces[0].envelope, 0)).toBe(0.25);
  expect(validateProject(p)).toEqual(p);
});
it('zero fades restore full region volume, while invalid fades leave the project unchanged', () => {
  const base = fixture(),
    faded = editVoice(base, 'take', 0, 2000, { kind: 'fade', fadeInMs: 300, fadeOutMs: 300 });
  const clear = editVoice(faded, 'take', 0, 2000, { kind: 'fade', fadeInMs: 0, fadeOutMs: 0 });
  expect(clear.voiceEdits!.take.pieces[0].envelope).toEqual([
    { atMs: 0, level: 1 },
    { atMs: 2000, level: 1 },
  ]);
  expect(() =>
    editVoice(base, 'take', 0, 100, { kind: 'fade', fadeInMs: 100, fadeOutMs: 1 }),
  ).toThrow('INVALID_VOICE_FADE');
  expect(base.voiceEdits).toBeUndefined();
  const invalid = structuredClone(faded);
  invalid.voiceEdits!.take.pieces[0].envelope![0].level = 2;
  expect(() => validateProject(invalid)).toThrow('INVALID_VOICE_EDIT');
});
it('inserts actual silence at a point and preserves original/subtitles/other onsets', () => {
  const p = fixture(),
    next = editVoice(p, 'take', 500, 500, { kind: 'silence', durationMs: 300 });
  expect(next.voiceEdits!.take.pieces.map((p) => p.durationMs)).toEqual([500, 300, 1500]);
  expect(next.voiceEdits!.take.pieces[1].sourceStartMs).toBeNull();
  expect(dubbingClips(next)[0].endMs - dubbingClips(next)[0].startMs).toBe(2300);
  expect(next.sourceCues).toEqual(p.sourceCues);
  expect(next.targetCues).toEqual(p.targetCues);
  expect(next.generations).toEqual(p.generations);
  expect(p.voiceEdits).toBeUndefined();
  expect(validateProject(JSON.parse(JSON.stringify(next)))).toEqual(next);
});
it('deletes only the selected audio and closes its gap', () => {
  const p = editVoice(fixture(), 'take', 300, 800, { kind: 'delete' }),
    pieces = p.voiceEdits!.take.pieces;
  expect(editDuration(p.voiceEdits!.take)).toBe(1500);
  expect(pieces.map((p) => [p.sourceStartMs, p.sourceEndMs])).toEqual([
    [0, 300],
    [800, 2000],
  ]);
  expect(mixReport(editVoice(p, 'take', 0, 800, { kind: 'delete' })).fast).toBe(0);
});
it('mutes and amplifies selections without changing timing, including after stretching', () => {
  let p = editVoice(fixture(), 'take', 500, 1000, { kind: 'stretch', durationMs: 1000 });
  p = editVoice(p, 'take', 500, 1500, { kind: 'gain', gain: 2 });
  expect(p.voiceEdits!.take.pieces[1]).toEqual({
    sourceStartMs: 500,
    sourceEndMs: 1000,
    durationMs: 1000,
    gain: 2,
  });
  p = editVoice(p, 'take', 500, 1500, { kind: 'gain', gain: 0 });
  expect(editDuration(p.voiceEdits!.take)).toBe(2500);
  expect(p.voiceEdits!.take.pieces[1].gain).toBe(0);
});
it('compresses a region spanning sound and inserted silence to an exact duration', () => {
  let p = editVoice(fixture(), 'take', 1000, 1000, { kind: 'silence', durationMs: 500 });
  p = editVoice(p, 'take', 500, 2000, { kind: 'stretch', durationMs: 600 });
  expect(editDuration(p.voiceEdits!.take)).toBe(1600);
  expect(p.voiceEdits!.take.pieces.map((p) => p.durationMs)).toEqual([500, 200, 200, 200, 500]);
});
it('uses fitted coordinates instead of cutting the raw tail', () => {
  const base = fixture(),
    p = resizeDubbing(base, base.dialogues[0].id, 1000);
  const next = editVoice(p, 'take', 500, 1000, { kind: 'gain', gain: 0.5 });
  expect(next.voiceEdits!.take.pieces[1]).toEqual({
    sourceStartMs: 1000,
    sourceEndMs: 2000,
    durationMs: 500,
    gain: 0.5,
  });
});
it('rejects invalid/empty edits and overflow before changing the project', () => {
  const p = fixture();
  for (const args of [
    [0, 2000, { kind: 'delete' }],
    [0, 100, { kind: 'gain', gain: 3 }],
    [0, 0, { kind: 'stretch', durationMs: 50 }],
    [-1, 0, { kind: 'silence', durationMs: 2 }],
  ] as const)
    expect(() => editVoice(p, 'take', args[0], args[1], args[2])).toThrow('INVALID_VOICE_EDIT');
  expect(() => editVoice(p, 'take', 0, 0, { kind: 'silence', durationMs: 20000 })).toThrow(
    'VOICE_EDIT_NO_ROOM',
  );
  expect(p.voiceEdits).toBeUndefined();
});
it('invalidates only this take cache and survives background generation/reopen', () => {
  const base = fixture(),
    local = editVoice(base, 'take', 0, 500, { kind: 'gain', gain: 0.5 }),
    incoming = structuredClone(base);
  incoming.generations.push({ ...incoming.generations[0], id: 'new' });
  const merged = rebaseProject(base, local, incoming);
  expect(merged.generations).toHaveLength(2);
  expect(merged.voiceEdits).toEqual(local.voiceEdits);
  expect(dubbingClips(merged)[0].cacheKey).not.toBe(dubbingClips(base)[0].cacheKey);
  expect(validateProject(merged)).toEqual(merged);
});
it('restores the original and removes orphaned edits when deleting a take', () => {
  const base = fixture(),
    p = editVoice(base, 'take', 0, 500, { kind: 'delete' });
  const restored = resetVoiceEdit(p, 'take');
  expect(restored.voiceEdits?.take).toBeUndefined();
  expect(voicePlan(restored, base.generations[0] as Generation).pieces[0].durationMs).toBe(2000);
  const removed = deleteGeneration(p, 'take');
  expect(removed.voiceEdits?.take).toBeUndefined();
  expect(validateProject(removed)).toEqual(removed);
});
it('rejects corrupt persisted edits, version downgrade and unknown takes', () => {
  const p = editVoice(fixture(), 'take', 100, 200, { kind: 'gain', gain: 2 });
  const bad = structuredClone(p);
  bad.voiceEdits!.take.pieces[0].sourceEndMs = 90000;
  expect(() => validateProject(bad)).toThrow('INVALID_VOICE_EDIT');
  bad.voiceEdits = p.voiceEdits;
  bad.formatVersion = 10;
  expect(() => validateProject(bad)).toThrow('INVALID_VOICE_EDIT');
});
it('maps a later whole-take resize into local coordinates before another edit', () => {
  let p = editVoice(fixture(), 'take', 500, 1000, { kind: 'gain', gain: 0.5 });
  p = resizeDubbing(p, p.dialogues[0].id, 1000);
  const take = p.generations[0] as Generation;
  expect(editDuration(voicePlan(p, take))).toBe(1000);
  const next = editVoice(p, 'take', 250, 500, { kind: 'gain', gain: 2 });
  expect(next.voiceEdits!.take.pieces[1]).toEqual({
    sourceStartMs: 500,
    sourceEndMs: 1000,
    durationMs: 250,
    gain: 2,
  });
});
