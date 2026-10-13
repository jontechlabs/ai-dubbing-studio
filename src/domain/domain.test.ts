import { describe, expect, it } from 'vitest';
import { formatTime, loopRange, parseTime, timeToX, xToTime } from './time';
import { alignCues, dialogueText, editDialogue, exportSrt, parseSrt } from './subtitles';
import { demoProject, validateProject } from './project';
import fr from '../locales/fr.json';
import en from '../locales/en.json';

describe('timecode and timeline boundaries', () => {
  it('roundtrips long recordings without floating point drift', () => {
    for (const ms of [0, 1, 999, 128157, 3599999, 3600000, 381234567])
      expect(parseTime(formatTime(ms))).toBe(ms);
    expect(() => parseTime('00:62:00,000')).toThrow();
  });
  it('clips loops and timeline seeks at the media boundaries', () => {
    expect(loopRange(100, 900, 1000, 750)).toEqual({ start: 0, end: 1000 });
    expect(xToTime(timeToX(128157, 120000, 0.03), 120000, 0.03, 240000)).toBe(128157);
    expect(xToTime(-20, 0, 0.01, 1000)).toBe(0);
  });
});
describe('subtitle imports and bilingual matching', () => {
  it('preserves Japanese text, BOM, CRLF, multiline cues and overlapping cues', () => {
    const cues = parseSrt(
      '\uFEFF1\r\n00:00:01,000 --> 00:00:03,000\r\n殺さないで\r\nください！\r\n\r\n2\r\n00:00:02,000 --> 00:00:04,000\r\nHello',
    );
    expect(cues[0].text).toBe('殺さないで\nください！');
    const reload = parseSrt(exportSrt(cues));
    expect(reload.map((c) => c.text)).toEqual(cues.map((c) => c.text));
  });
  it('rejects reversed timings and malformed subtitles', () => {
    expect(() => parseSrt('1\n00:00:03,000 --> 00:00:01,000\nOops')).toThrow();
    expect(() => parseSrt('Not a subtitle')).toThrow();
  });
  it('retains every ambiguous source and target cue', () => {
    const a = parseSrt(
      '1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:00:01,010 --> 00:00:02,010\nB',
    );
    const b = parseSrt('1\n00:00:01,000 --> 00:00:02,000\nC');
    const result = alignCues(a, b);
    expect(result).toHaveLength(3);
    expect(result.every((d) => d.warnings.includes('alignment'))).toBe(true);
  });
});
describe('project edits and format contracts', () => {
  it('stores TTS pronunciation separately and reloads project JSON', () => {
    const p = demoProject();
    const line = p.dialogues[0];
    const original = dialogueText(p, line, 'target');
    const edited = editDialogue(p, line.id, 'tts', 'Zutte !');
    expect(dialogueText(edited, edited.dialogues[0], 'target')).toBe(original);
    expect(validateProject(JSON.parse(JSON.stringify(edited))).dialogues[0].ttsText).toBe(
      'Zutte !',
    );
  });
  it('rejects unknown versions and dangling cue references', () => {
    const p = demoProject();
    expect(() => validateProject({ ...p, formatVersion: 99 })).toThrow();
    p.dialogues[0].sourceCueIds = ['missing'];
    expect(() => validateProject(p)).toThrow();
  });
  it('includes every interface translation in both languages', () => {
    const keys = (object: object, prefix = ''): string[] =>
      Object.entries(object).flatMap(([key, value]) =>
        typeof value === 'object' ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`],
      );
    expect(keys(fr).sort()).toEqual(keys(en).sort());
  });
});
