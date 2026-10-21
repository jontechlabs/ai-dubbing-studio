import { describe, expect, it } from 'vitest';
import { moodFormatVersion, moodGroup, moodGroups, validMood, voiceMoods } from './voiceMoods';
import { defaultVoiceSettings, editVoiceSettings, validVoiceSettings } from './tts';
import { demoProject, validateProject } from './project';
import fr from '../locales/fr.json';
import en from '../locales/en.json';

describe('acting catalogue', () => {
  it('offers every localized intention exactly once, retaining legacy formats', () => {
    expect(voiceMoods).toHaveLength(43);
    expect(voiceMoods).toEqual(expect.arrayContaining(['dying', 'stressed', 'laughing']));
    expect(
      voiceMoods
        .filter((id) => moodGroup(id) !== 'reference')
        .every((id) => moodGroups.some((group) => group === moodGroup(id))),
    ).toBe(true);
    for (const id of voiceMoods) {
      expect(fr.moods[id]).toBeTruthy();
      expect(en.moods[id]).toBeTruthy();
      const p = demoProject();
      const next = editVoiceSettings(p, p.dialogues[0].id, { ...defaultVoiceSettings, mood: id });
      expect(next.formatVersion).toBe(moodFormatVersion(id));
      expect(validateProject(JSON.parse(JSON.stringify(next)))).toEqual(next);
      expect(next.generations).toEqual(p.generations);
      expect(next.sourceCues).toEqual(p.sourceCues);
      expect(next.targetCues).toEqual(p.targetCues);
      if (moodFormatVersion(id) === 15)
        expect(() => validateProject({ ...next, formatVersion: 14 })).toThrow(
          'INVALID_TTS_REQUEST',
        );
    }
    expect(moodFormatVersion('default')).toBe(5);
    expect(moodFormatVersion('angry')).toBe(7);
  });
  it('validates all engine combinations and rejects unknown or malformed moods', () => {
    for (const id of voiceMoods) {
      for (const variantId of [
        'cosy3-official',
        'fish-s2-fp8',
        'fish-s2-gguf-q8',
        'drama3-comfy-fp8',
      ])
        expect(validVoiceSettings({ ...defaultVoiceSettings, variantId, mood: id })).toBe(true);
      expect(
        validVoiceSettings({ ...defaultVoiceSettings, variantId: 'qwen3-06b-gguf-q8', mood: id }),
      ).toBe(id === 'default');
    }
    for (const value of ['unknown', '', 'toString', '__proto__', 42, [], {}])
      expect(validMood(value)).toBe(false);
    expect(validMood(undefined)).toBe(true);
  });
});
