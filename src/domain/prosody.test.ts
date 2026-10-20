import { describe, it, expect } from 'vitest';
import { demoProject, validateProject } from './project';
import { defaultVoiceSettings, deleteGeneration, spokenText } from './tts';
import { validProsodyOptions, type ProsodyOptions } from './prosody';
import type { Generation } from './types';
const options: ProsodyOptions = {
  generationId: 'base',
  referenceMode: 'dialogue',
  referenceId: null,
  strength: 0.5,
  pitch: true,
  rhythm: true,
  energy: true,
};
function sample() {
  const p = demoProject();
  p.formatVersion = 14;
  const l = p.dialogues[0];
  const base: Generation = {
    kind: 'tts',
    id: 'base',
    dialogueId: l.id,
    providerId: 'cosyvoice3',
    modelId: 'cosy3-official',
    path: 'generations/base.wav',
    createdAt: new Date().toISOString(),
    sourcePath: p.media!.path,
    startMs: l.startMs,
    endMs: l.endMs,
    text: spokenText(p, l),
    language: 'fr',
    characterId: null,
    durationMs: 2000,
    sampleRate: 24000,
    options: { ...defaultVoiceSettings },
    referenceTranscript: 'Hello',
    device: 'cpu',
    deviceName: 'CPU',
    peakVramMb: 0,
    inputHash: 'hash',
  };
  const derived: Generation = {
    ...structuredClone(base),
    id: 'derived',
    path: 'generations/derived.wav',
    prosodyTransfer: {
      algorithm: 'praat-psola-v1',
      sourceGenerationId: 'base',
      sourceDurationMs: 2000,
      guideDurationMs: 2500,
      options: { ...options },
    },
  };
  p.generations = [base, derived];
  l.selectedGenerationIds.fr = 'derived';
  return p;
}
describe('independent intonation takes', () => {
  it('validates bounded settings and requires a guide for reference mode', () => {
    expect(validProsodyOptions(options)).toBe(true);
    expect(validProsodyOptions({ ...options, strength: 0 })).toBe(true);
    for (const strength of [-0.1, 1.1, NaN, Infinity])
      expect(validProsodyOptions({ ...options, strength })).toBe(false);
    expect(validProsodyOptions({ ...options, pitch: false, rhythm: false, energy: false })).toBe(
      false,
    );
    expect(validProsodyOptions({ ...options, referenceMode: 'reference' })).toBe(false);
    expect(validProsodyOptions({ ...options, script: 'unexpected' })).toBe(false);
  });
  it('keeps derived audio independent when its original take is deleted later', () => {
    const p = sample(),
      derived = structuredClone(p.generations[1]);
    expect(validateProject(p)).toEqual(p);
    const next = deleteGeneration(p, 'base');
    expect(validateProject(next).generations).toEqual([derived]);
    expect(p.generations).toHaveLength(2);
  });
  it('rejects unsupported format, self-references and invalid duration metadata', () => {
    const p = sample();
    p.formatVersion = 13;
    expect(() => validateProject(p)).toThrow('INVALID_PROSODY_REQUEST');
    p.formatVersion = 14;
    const g = p.generations[1] as Generation;
    g.prosodyTransfer!.sourceGenerationId = 'derived';
    expect(() => validateProject(p)).toThrow('INVALID_PROSODY_REQUEST');
    g.prosodyTransfer!.sourceGenerationId = 'base';
    g.prosodyTransfer!.guideDurationMs = 30001;
    expect(() => validateProject(p)).toThrow('INVALID_PROSODY_REQUEST');
  });
});
