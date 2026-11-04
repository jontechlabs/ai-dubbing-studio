import { describe, it, expect } from 'vitest';
import { coverPoint, projectName, browserEntry } from './projectLibrary';
import { blankProject } from './project';
describe('project catalogue', () => {
  it('uses two minutes in long videos and an interior point in short videos', () => {
    expect(coverPoint(3600000)).toBe(120000);
    expect(coverPoint(16000)).toBe(6400);
    expect(coverPoint(100)).toBe(0);
  });
  it('keeps manual frames inside the clip and rejects invalid times', () => {
    expect(coverPoint(16000, 0)).toBe(0);
    expect(coverPoint(16000, 15999)).toBe(15900);
    for (const n of [-1, 16000, NaN, Infinity, 1.5])
      expect(() => coverPoint(16000, n)).toThrow('INVALID_COVER_TIME');
  });
  it('validates display names without turning punctuation into file paths', () => {
    expect(projectName('  Scène 日本語 / FR  ')).toBe('Scène 日本語 / FR');
    for (const n of ['', '  ', 'retour\nligne', 'a'.repeat(161), '\u0085'])
      expect(() => projectName(n)).toThrow('INVALID_PROJECT_NAME');
  });
  it('lists empty browser projects and trash without changing their data', () => {
    const p = blankProject('Projet');
    const before = structuredClone(p);
    const e = browserEntry(p, '2026-11-04T00:00:00Z');
    expect(e.hasVideo).toBe(false);
    expect(e.durationMs).toBeNull();
    expect(e.trashedAt).toBe('2026-11-04T00:00:00Z');
    expect(p).toEqual(before);
  });
});
