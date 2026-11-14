import { it, expect } from 'vitest';
import { demoProject, validateProject } from './project';
import { auditBasis, auditFresh, currentAuditRows } from './dubbingAudit';
function fixture() {
  const p = demoProject();
  p.formatVersion = 29;
  p.dubbingAudit = {
    id: 'audit',
    createdAt: new Date().toISOString(),
    basis: auditBasis(p),
    voicesStatus: 'disabled',
    sourceTrackId: 'original',
    rows: p.dialogues.map((l) => ({
      lineId: l.id,
      takeId: null,
      tags: ['missing'],
      metrics: null,
      sourceVoices: null,
      dubbingVoices: null,
      error: null,
    })),
  };
  return p;
}
it('saved audit remains current on review changes, but not audio, text, timing or take changes', () => {
  const p = fixture();
  expect(auditFresh(p)).toBe(true);
  expect(validateProject(p)).toEqual(p);
  const review = structuredClone(p);
  review.dialogues[0].status = 'review';
  expect(auditFresh(review)).toBe(true);
  for (const change of [
    (v: typeof p) => {
      v.dialogues[0].endMs++;
    },
    (v: typeof p) => {
      v.dialogues[0].selectedGenerationIds.fr = 'other';
    },
    (v: typeof p) => {
      v.targetCues[0].text += ' changed';
    },
  ]) {
    const changed = structuredClone(p);
    change(changed);
    expect(auditFresh(changed)).toBe(false);
  }
  const reorder = structuredClone(p);
  reorder.dubbingAudit!.basis = JSON.parse(JSON.stringify(reorder.dubbingAudit!.basis));
  expect(auditFresh(reorder)).toBe(true);
  const corrected = structuredClone(p);
  corrected.dialogues[0].ttsText = 'New text';
  expect(currentAuditRows(corrected).size).toBe(p.dialogues.length - 1);
  expect(currentAuditRows(corrected).has(p.dialogues[1].id)).toBe(true);
});
it('old project formats and malformed tags cannot masquerade as valid analysis', () => {
  const p = fixture();
  expect(() => validateProject({ ...p, formatVersion: 28 })).toThrow('INVALID_DUBBING_AUDIT');
  const invalid = structuredClone(p);
  (invalid.dubbingAudit!.rows[0].tags as string[]).push('invented');
  expect(() => validateProject(invalid)).toThrow('INVALID_DUBBING_AUDIT');
  const duplicate = structuredClone(p);
  duplicate.dubbingAudit!.rows.push(duplicate.dubbingAudit!.rows[0]);
  expect(() => validateProject(duplicate)).toThrow('INVALID_DUBBING_AUDIT');
});
