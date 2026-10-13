import { describe, expect, it } from 'vitest';
import { blankProject, demoProject, validateProject } from './project';
import { alignCues, dialogueText, exportSrt, parseSrt } from './subtitles';
import { analyzeAlignment, applyAlignment } from './alignment';
import { editCueText, mergeDialogue, moveCue, retimeDialogue, splitDialogue } from './timing';
import { audioPeaks } from './waveform';

function fixture(offset = 2300, rate = 1) {
  const project = blankProject('Timing', 'ja', 'fr');
  project.sourceCues = [1000, 5800, 13300, 21000, 29100, 41800, 55400, 73000].map((startMs, i) => ({
    id: `s${i}`,
    startMs,
    endMs: startMs + [1700, 2200, 3600, 1900, 2900, 1800, 4100, 2100][i],
    text: `日本語 ${i}`,
  }));
  project.targetCues = project.sourceCues.map((cue, i) => ({
    ...cue,
    id: `t${i}`,
    startMs: Math.round((cue.startMs - offset) / rate),
    endMs: Math.round((cue.endMs - offset) / rate),
    text: `Français ${i}`,
  }));
  project.dialogues = alignCues(project.sourceCues, project.targetCues);
  return project;
}
describe('automatic bilingual synchronization', () => {
  it('corrects positive and negative offsets without changing text or reference timings', () => {
    for (const offset of [-2300, 500]) {
      const p = fixture(offset);
      p.dialogues[0].ttsText = 'Prononciation indépendante';
      p.generations = [{ id: 'old-audio' }];
      const proposal = analyzeAlignment(p, 'source');
      expect(proposal.ambiguous).toBe(false);
      expect(proposal.offsetMs).toBeCloseTo(offset, -1);
      const next = validateProject(applyAlignment(p, proposal));
      expect(next.sourceCues).toEqual(p.sourceCues);
      expect(next.targetCues.map((c) => [c.startMs, c.endMs])).toEqual(
        p.sourceCues.map((c) => [c.startMs, c.endMs]),
      );
      expect(next.targetCues.map((c) => [c.id, c.text])).toEqual(
        p.targetCues.map((c) => [c.id, c.text]),
      );
      expect(next.dialogues.some((d) => d.ttsText === 'Prononciation indépendante')).toBe(true);
      expect(next.generations).toEqual(p.generations);
      expect(parseSrt(exportSrt(next.targetCues)).map((c) => c.startMs)).toEqual(
        p.sourceCues.map((c) => c.startMs),
      );
    }
  });
  it('estimates drift and supports choosing translated SRT as reference', () => {
    const p = fixture(-1200, 1.045);
    const result = analyzeAlignment(p, 'source');
    expect(result.ambiguous).toBe(false);
    expect(result.rate).toBeCloseTo(1.045, 3);
    const backwards = applyAlignment(p, analyzeAlignment(p, 'target'));
    expect(backwards.targetCues).toEqual(p.targetCues);
    expect(backwards.sourceCues.map((c) => c.startMs)).toEqual(p.targetCues.map((c) => c.startMs));
  });
  it('handles missing cues and a one-to-many subtitle without overwriting unmatched timing', () => {
    const p = fixture(-1700);
    p.targetCues = p.targetCues.filter((c) => c.id !== 't4');
    const original = p.targetCues[2];
    const middle = Math.round((original.startMs + original.endMs) / 2);
    p.targetCues.splice(
      2,
      1,
      { ...original, endMs: middle, text: 'Première moitié' },
      { ...original, id: 't2b', startMs: middle, text: 'Seconde moitié' },
    );
    p.targetCues.push({ id: 'extra', startMs: 100_000, endMs: 102_000, text: 'Non associé' });
    p.dialogues = alignCues(p.sourceCues, p.targetCues);
    const result = analyzeAlignment(p, 'source');
    expect(result.ambiguous).toBe(false);
    expect(result.unmatched).toBe(2);
    const next = applyAlignment(p, result);
    const group = next.dialogues.find((d) => d.sourceCueIds.includes('s2'))!;
    expect(group.targetCueIds).toEqual(['t2', 't2b']);
    const editedGroup = editCueText(next, 'target', 't2b', 'Modifié');
    expect(editedGroup.targetCues.find((c) => c.id === 't2')?.text).toBe('Première moitié');
    expect(editedGroup.targetCues.find((c) => c.id === 't2b')?.text).toBe('Modifié');
    expect(dialogueText(next, group, 'target')).toBe('Première moitié\nSeconde moitié');
    expect(next.targetCues.find((c) => c.id === 'extra')).toEqual(
      p.targetCues.find((c) => c.id === 'extra'),
    );
    expect(next.dialogues.flatMap((d) => d.sourceCueIds).sort()).toEqual(
      p.sourceCues.map((c) => c.id).sort(),
    );
    expect(new Set(next.dialogues.map((d) => d.id)).size).toBe(next.dialogues.length);
  });
  it('refuses insufficient and ambiguous periodic matches', () => {
    const p = fixture(-3000);
    p.targetCues = p.targetCues.slice(0, 2);
    expect(() => analyzeAlignment(p, 'source')).toThrow('ALIGNMENT_TOO_FEW');
    p.sourceCues = Array.from({ length: 40 }, (_, i) => ({
      id: `s${i}`,
      startMs: 1000 + i * 5000,
      endMs: 3000 + i * 5000,
      text: 'A',
    }));
    p.targetCues = p.sourceCues.map((c, i) => ({
      ...c,
      id: `t${i}`,
      startMs: c.startMs + 2000,
      endMs: c.endMs + 2000,
    }));
    const result = analyzeAlignment(p, 'source');
    expect(result.ambiguous).toBe(true);
    expect(() => applyAlignment(p, result)).toThrow('ALIGNMENT_AMBIGUOUS');
  });
});
describe('time editing and reversible restructuring', () => {
  it('edits one cue independently and scales both linked tracks while keeping TTS', () => {
    const p = demoProject(),
      line = p.dialogues[0];
    line.ttsText = 'Voix';
    const moved = moveCue(p, 'target', line.targetCueIds[0], 1500, 4000);
    expect(moved.sourceCues).toEqual(p.sourceCues);
    expect(moved.dialogues[0].endMs).toBe(4000);
    const both = retimeDialogue(moved, line.id, 2000, 5000, 'both');
    expect(both.sourceCues[0].startMs).toBe(2000);
    expect(both.targetCues[0].endMs).toBe(5000);
    expect(both.dialogues[0].ttsText).toBe('Voix');
    expect(() => moveCue(p, 'target', line.targetCueIds[0], -1, 3000)).toThrow();
    expect(() => retimeDialogue(p, line.id, 3000, 2000, 'both')).toThrow();
  });
  it('splits graphemes and merges references without losing either subtitle or audio asset', () => {
    const p = demoProject(),
      id = p.dialogues[0].id;
    p.sourceCues[0].text = 'こんにちは 👨‍👩‍👧‍👦 世界';
    p.dialogues[0].ttsText = 'Bonjour tout le monde';
    p.generations = [{ id: 'retained' }];
    const divided = validateProject(splitDialogue(p, id, 2000));
    expect(divided.dialogues).toHaveLength(5);
    const merged = validateProject(mergeDialogue(divided, id));
    expect(merged.dialogues).toHaveLength(4);
    expect(dialogueText(merged, merged.dialogues[0], 'source').replace(/\s/g, '')).toBe(
      p.sourceCues[0].text.replace(/\s/g, ''),
    );
    expect(merged.dialogues[0].ttsText?.replace(/\s/g, '')).toBe('Bonjourtoutlemonde');
    expect(merged.generations).toEqual(p.generations);
    expect(merged.sourceCues).toHaveLength(4);
    expect(merged.targetCues).toHaveLength(4);
    expect(parseSrt(exportSrt(merged.targetCues))).toHaveLength(4);
  });
  it('rejects a split outside the line and a merge past the last line', () => {
    const p = demoProject();
    expect(() => splitDialogue(p, p.dialogues[0].id, 0)).toThrow('INVALID_SPLIT');
    expect(() => mergeDialogue(p, p.dialogues.at(-1)!.id)).toThrow('NO_NEXT_DIALOGUE');
  });
});
it('computes real amplitude peaks, including silence and a partial final bin', () => {
  const samples = new Float32Array(330);
  samples[180] = -0.8;
  samples[329] = 0.3;
  const data = audioPeaks(samples, 8000);
  expect(data.peaks).toHaveLength(3);
  expect(data.peaks[0]).toBe(0);
  expect(data.peaks[1]).toBeCloseTo(0.8);
  expect(data.peaks[2]).toBeCloseTo(0.3);
});
