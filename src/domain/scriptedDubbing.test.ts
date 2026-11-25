import { describe, expect, it } from 'vitest';
import cases from '../../tests/fixtures/speaker-scripts.json';
import { parseSpeakerScript, scriptSlots } from './scriptedDubbing';
describe('speaker script editor syntax', () => {
  for (const fixture of cases.valid)
    it('parses blocks without sending labels to TTS: ' + fixture.script.slice(0, 30), () => {
      expect(parseSpeakerScript(fixture.script)).toEqual(fixture.turns);
    });
  for (const script of cases.invalid)
    it('rejects malformed or empty interventions: ' + script, () => {
      expect(() => parseSpeakerScript(script)).toThrow('SCRIPT_INVALID');
    });
  it('bounds script size, turn count, speaker count and per-turn text', () => {
    for (const script of [
      '[Speaker 1] ' + 'é'.repeat(33000),
      Array.from({ length: 129 }, () => '[Speaker 1] Oui').join('\n'),
      Array.from({ length: 17 }, (_, i) => `[Speaker ${i + 1}] Oui`).join('\n'),
    ])
      expect(() => parseSpeakerScript(script)).toThrow('SCRIPT_INVALID');
  });
  it('suggests independent sequential slots that the user can overlap explicitly', () => {
    const turns = parseSpeakerScript(cases.valid[0].script);
    expect(scriptSlots(turns, 10000, 2500)).toEqual([
      { startMs: 10000, endMs: 12500 },
      { startMs: 12500, endMs: 15000 },
    ]);
  });
});
