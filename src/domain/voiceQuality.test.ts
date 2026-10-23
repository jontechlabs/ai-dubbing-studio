import { expect, it } from 'vitest';
import catalog from '../../workers/voice-quality.json' with { type: 'json' };
import { qualitySpec, resolvedQuality, qualityPreset, validQuality } from './voiceQuality';
import { defaultVoiceSettings, editVoiceSettings, validVoiceSettings } from './tts';
import { demoProject, validateProject } from './project';

it('uses the real variant parameters and bounds every preset', () => {
  for (const [id, spec] of Object.entries(catalog.variants)) {
    for (const [name, preset] of Object.entries(spec.presets)) {
      expect(validQuality(preset, id)).toBe(true);
      expect(qualityPreset(id, preset)).toBe(name);
    }
    expect(validQuality(resolvedQuality(id), id)).toBe(true);
  }
  expect(resolvedQuality('voxcpm2-bf16', qualitySpec('voxcpm2-bf16')!.presets.natural)).toEqual({
    inferenceSteps: 20,
    cfgStrength: 1.6,
  });
});
it('rejects mismatched, unknown, nonfinite and out-of-range controls', () => {
  for (const quality of [
    null,
    [],
    { inferenceSteps: 31 },
    { inferenceSteps: 4.5 },
    { cfgStrength: NaN },
    { cfgStrength: Infinity },
    { cfgStrength: '1.6' },
    { cfgStrength: true },
    { cfgStrength: 0.9 },
    { unknown: 1 },
  ])
    expect(
      validVoiceSettings({ ...defaultVoiceSettings, variantId: 'voxcpm2-bf16', quality }),
    ).toBe(false);
  expect(validQuality({ temperature: 0.8 }, 'cosy3-official')).toBe(false);
  expect(validQuality({ repetitionPenalty: 1.1 }, 'fish-s2-gguf-q8')).toBe(false);
});
it('persists format 19 quality without rewriting old takes or old defaults', () => {
  const before = demoProject();
  before.generations.push({ kind: 'separation', id: 'untouched' });
  const next = editVoiceSettings(before, before.dialogues[0].id, {
    ...defaultVoiceSettings,
    variantId: 'voxcpm2-bf16',
    quality: { inferenceSteps: 20, cfgStrength: 1.6 },
  });
  expect(next.formatVersion).toBe(19);
  expect(validateProject(JSON.parse(JSON.stringify(next)))).toEqual(next);
  expect(next.generations).toEqual(before.generations);
  expect(() => validateProject({ ...next, formatVersion: 18 })).toThrow();
  expect(defaultVoiceSettings.quality).toBeUndefined();
});
it('identifies custom changes and restores standard without hidden overrides', () => {
  expect(qualityPreset('voxcpm2-bf16', { inferenceSteps: 20, cfgStrength: 1.7 })).toBe('custom');
  expect(qualityPreset('voxcpm2-bf16')).toBe('standard');
  expect(resolvedQuality('voxcpm2-bf16')).toEqual({ inferenceSteps: 10, cfgStrength: 2 });
  expect(resolvedQuality('chatterbox-multilingual-v3').cfgWeight).toBe(0);
});
