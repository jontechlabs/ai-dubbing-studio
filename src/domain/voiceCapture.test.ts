import { test, expect } from 'vitest';
import { blankProject } from './project';
import { validateTakeOrigins } from './voiceCapture';
import { encodeMicrophone, MIC_RATE } from '../services/microphone';
test('microphone WAV has canonical lossless PCM data and rejects unsafe durations/samples', () => {
  const samples = new Float32Array(MIC_RATE).map((_, i) => Math.sin(i * 0.02));
  const wav = new DataView(encodeMicrophone(samples));
  expect(wav.byteLength).toBe(44 + MIC_RATE * 2);
  expect(wav.getUint32(24, true)).toBe(24000);
  expect(wav.getUint16(22, true)).toBe(1);
  expect(wav.getUint16(34, true)).toBe(16);
  expect(wav.getInt16(46, true)).toBe(Math.round(samples[1] * 32767));
  for (const bad of [new Float32Array(1), new Float32Array(MIC_RATE * 120 + 1), samples.fill(NaN)])
    expect(() => encodeMicrophone(bad)).toThrow('MIC_INVALID_AUDIO');
});
test('new take provenance requires format 17 and cannot refer to itself', () => {
  const project = blankProject();
  project.generations = [
    {
      id: 'new',
      kind: 'tts',
      takeOrigin: { type: 'conversion', sourceGenerationId: 'old', referenceId: 'ref' },
    },
  ];
  expect(() => validateTakeOrigins(project)).toThrow();
  project.formatVersion = 17;
  expect(() => validateTakeOrigins(project)).not.toThrow();
  (project.generations[0].takeOrigin as { sourceGenerationId: string }).sourceGenerationId = 'new';
  expect(() => validateTakeOrigins(project)).toThrow();
});
