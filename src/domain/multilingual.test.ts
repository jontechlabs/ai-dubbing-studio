import { expect, it } from 'vitest';
import { demoProject, validateProject } from './project';
import { defaultVoiceSettings, editVoiceSettings, validVoiceSettings } from './tts';
import { multilingualVariant, voiceSettingsFormat } from './voiceEngines';
import { validVoiceVariant } from './modelVariants';

it('roundtrips both installed multilingual engines in format 16 and preserves existing takes', () => {
  for (const [variantId, provider] of [
    ['voxcpm2-bf16', 'voxcpm2'],
    ['chatterbox-multilingual-v3', 'chatterbox'],
  ]) {
    const before = demoProject();
    before.generations.push({ kind: 'separation', id: 'existing-separation' });
    const next = editVoiceSettings(before, before.dialogues[0].id, {
      ...defaultVoiceSettings,
      variantId,
      device: 'cuda:0',
    });
    next.modelPreferences = { ttsProviderId: provider, voiceVariantId: variantId };
    expect(next.formatVersion).toBe(16);
    expect(voiceSettingsFormat(next.dialogues[0].voiceSettings!)).toBe(16);
    expect(validateProject(JSON.parse(JSON.stringify(next)))).toEqual(next);
    expect(next.generations).toEqual(before.generations);
    expect(before.formatVersion).toBeLessThan(16);
    expect(() => validateProject({ ...next, formatVersion: 15 })).toThrow();
    expect(validVoiceVariant(provider, variantId)).toBe(true);
    expect(multilingualVariant(variantId)).toBe(true);
  }
});

it('limits Chatterbox controls to supported capabilities while keeping VoxCPM directions', () => {
  expect(
    validVoiceSettings({
      ...defaultVoiceSettings,
      variantId: 'voxcpm2-bf16',
      mood: 'stressed',
      accent: 'fr-FR',
    }),
  ).toBe(true);
  expect(
    validVoiceSettings({
      ...defaultVoiceSettings,
      variantId: 'chatterbox-multilingual-v3',
      mood: 'happy',
    }),
  ).toBe(false);
  expect(
    validVoiceSettings({
      ...defaultVoiceSettings,
      variantId: 'chatterbox-multilingual-v3',
      accent: 'fr-FR',
    }),
  ).toBe(false);
  expect(validVoiceVariant('chatterbox', 'voxcpm2-bf16')).toBe(false);
});
