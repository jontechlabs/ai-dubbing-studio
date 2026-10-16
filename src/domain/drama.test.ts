import { expect, it } from 'vitest';
import { demoProject, validateProject } from './project';
import { defaultVoiceSettings, editVoiceSettings } from './tts';
import { voiceVariant } from './voiceEngines';
it('keeps Drama 3 separate from S2 through save, reopen and model preference validation', () => {
  const p = demoProject();
  p.modelPreferences = { ttsProviderId: 'fish-drama3', voiceVariantId: 'drama3-comfy-fp8' };
  const next = editVoiceSettings(p, p.dialogues[0].id, {
    ...defaultVoiceSettings,
    variantId: 'drama3-comfy-fp8',
    device: 'cuda:0',
    mode: 'zeroShot',
    mood: 'angry',
  });
  expect(validateProject(JSON.parse(JSON.stringify(next)))).toBeTruthy();
  expect(voiceVariant('drama3-comfy-fp8')?.providerId).toBe('fish-drama3');
  expect(voiceVariant('fish-s2-fp8')?.providerId).toBe('fish-s2');
});
