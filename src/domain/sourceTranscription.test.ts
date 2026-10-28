import { it, expect } from 'vitest';
import { demoProject } from './project';
import { sourceProposalCurrent, type SourceTranscriptionProposal } from './sourceTranscription';
it('accepts unrelated target edits and rejects stale source, time, language, file and native audio fingerprints', () => {
  const p = demoProject(),
    l = p.dialogues[0];
  const proposal: SourceTranscriptionProposal = {
    id: 'asr',
    model: 'Whisper',
    language: 'ja',
    trackId: 'original',
    stale: false,
    segments: [],
    basis: {
      projectId: p.id,
      lineId: l.id,
      sourceLanguage: p.languages.source,
      sourcePath: p.media!.path,
      startMs: l.startMs,
      endMs: l.endMs,
      slots: l.sourceCueIds.map((id) => {
        const c = p.sourceCues.find((c) => c.id === id)!;
        return { cueId: c.id, startMs: c.startMs, endMs: c.endMs, text: c.text };
      }),
    },
  };
  expect(sourceProposalCurrent(p, proposal)).toBe(true);
  p.targetCues[0].text = 'Une autre traduction';
  p.revision++;
  expect(sourceProposalCurrent(p, proposal)).toBe(true);
  for (const change of [
    (n: typeof p) => (n.sourceCues[0].text = 'Autre'),
    (n: typeof p) => n.sourceCues[0].endMs++,
    (n: typeof p) => n.dialogues[0].startMs++,
    (n: typeof p) => (n.languages.source = 'xx'),
    (n: typeof p) => (n.media!.path = 'another.mp4'),
  ]) {
    const n = structuredClone(p);
    change(n);
    expect(sourceProposalCurrent(n, proposal)).toBe(false);
  }
  expect(sourceProposalCurrent(p, { ...proposal, stale: true })).toBe(false);
});
