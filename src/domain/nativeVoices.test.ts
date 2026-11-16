import { it, expect } from 'vitest';
import { demoProject, validateProject } from './project';
import { defaultVoiceSettings, validVoiceSettings } from './tts';
import { voiceVariant, voiceSettingsFormat } from './voiceEngines';
import { validAccent } from './voiceAccents';
import { validQuality, resolvedQuality, qualityPreset } from './voiceQuality';
import { variantsFor } from './modelVariants';
it('new native voices persist with format 31 without changing old takes or accepting unsupported modes', () => {
  for (const [id, provider] of [
    ['zonos3-mini-gguf', 'zonos3'],
    ['moss-local-v15-gguf-q8', 'moss-tts-local'],
  ]) {
    const settings = { ...defaultVoiceSettings, variantId: id, referenceMode: 'current' as const };
    expect(validVoiceSettings(settings)).toBe(true);
    expect(voiceVariant(id)?.providerId).toBe(provider);
    expect(variantsFor(provider).map((v) => v.id)).toEqual([id]);
    expect(voiceSettingsFormat(settings)).toBe(31);
    expect(validVoiceSettings({ ...settings, mode: 'zeroShot' })).toBe(false);
    expect(validVoiceSettings({ ...settings, mood: 'angry' })).toBe(false);
    const p = demoProject();
    const before = structuredClone(p.generations);
    p.formatVersion = 31;
    p.dialogues[0].voiceSettings = settings;
    p.modelPreferences = { ttsProviderId: provider, voiceVariantId: id };
    expect(validateProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect(p.generations).toEqual(before);
    expect(() => validateProject({ ...p, formatVersion: 30 })).toThrow();
    expect(() => validateProject({ ...p, formatVersion: 33 })).toThrow();
  }
});
it('ZONOS3 exposes only the French direction that is actually implemented, with bounded independent strength', () => {
  expect(validAccent('fr-FR', 'zonos3-mini-gguf')).toBe(true);
  for (const accent of ['fr-CA', 'fr-BE', 'fr-CH'])
    expect(validAccent(accent, 'zonos3-mini-gguf')).toBe(false);
  expect(validAccent('fr-FR', 'moss-local-v15-gguf-q8')).toBe(false);
  expect(validQuality({ accentStrength: 0 }, 'zonos3-mini-gguf')).toBe(true);
  expect(validQuality({ accentStrength: 1.5 }, 'zonos3-mini-gguf')).toBe(true);
  for (const value of [-1, 1.51, NaN, Infinity])
    expect(validQuality({ accentStrength: value }, 'zonos3-mini-gguf')).toBe(false);
  expect(validQuality({ accentStrength: 1 }, 'voxcpm2-bf16')).toBe(false);
  expect(qualityPreset('zonos3-mini-gguf', { accentStrength: 0.75 })).toBe('standard');
  expect(
    qualityPreset('zonos3-mini-gguf', {
      accentStrength: 0.75,
      temperature: 0.65,
      topP: 0.65,
      repetitionPenalty: 2.6,
    }),
  ).toBe('stable');
  expect(resolvedQuality('zonos3-mini-gguf')).toMatchObject({
    temperature: 0.75,
    topP: 0.69,
    topK: 80,
    repetitionPenalty: 2.4,
    cfgStrength: 1,
    accentStrength: 1,
  });
});
