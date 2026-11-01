import { expect, it } from 'vitest';
import { demoProject, validateProject } from './project';
import { defaultVoiceSettings, editVoiceSettings, validVoiceSettings } from './tts';
import { voiceVariant } from './voiceEngines';
import { validVoiceVariant } from './modelVariants';
import { validQuality } from './voiceQuality';
import manifest from '../../workers/voice-engines.json' with { type: 'json' };

const id = 'audio8-realistic-06b-gguf-q8';
const settings = { ...defaultVoiceSettings, variantId: id, mode: 'zeroShot' as const };

it('exposes the pinned Realistic model with its own provider, codec and supported controls', () => {
  expect(voiceVariant(id)?.providerId).toBe('audio8-tts');
  expect(validVoiceVariant('audio8-tts', id)).toBe(true);
  expect(validVoiceVariant('qwen3-tts', id)).toBe(false);
  const model = manifest.variants.find((v) => v.id === id)!;
  expect(model.engine).toBe('audiocpp');
  expect(model.files[0]).toMatchObject({
    size: 1429460800,
    sha256: 'e8a2402b50341b12316f94e78afd8b69d38010c5d3ba3878d64ca8f9ea90a930',
  });
  expect(validVoiceSettings(settings)).toBe(true);
  expect(validVoiceSettings({ ...settings, mode: 'crossLingual' })).toBe(false);
  expect(validVoiceSettings({ ...settings, mood: 'happy' })).toBe(false);
  expect(validVoiceSettings({ ...settings, accent: 'fr-FR' })).toBe(false);
  expect(validQuality({ temperature: 0.8, topP: 0.9, topK: 30 }, id)).toBe(true);
  expect(validQuality({ repetitionPenalty: 1.1 }, id)).toBe(false);
});

it('upgrades only the edited project and preserves all previous takes and subtitles', () => {
  const old = demoProject();
  old.generations.push({ kind: 'separation', id: 'existing' });
  const next = editVoiceSettings(old, old.dialogues[0].id, settings);
  next.modelPreferences = { ttsProviderId: 'audio8-tts', voiceVariantId: id };
  expect(next.formatVersion).toBe(26);
  expect(validateProject(JSON.parse(JSON.stringify(next)))).toEqual(next);
  expect(() => validateProject({ ...next, formatVersion: 25 })).toThrow();
  expect(next.generations).toEqual(old.generations);
  expect(next.sourceCues).toEqual(old.sourceCues);
  expect(next.targetCues).toEqual(old.targetCues);
  expect(old.dialogues[0].voiceSettings).toBeUndefined();
});
