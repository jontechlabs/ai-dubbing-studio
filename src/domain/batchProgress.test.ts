import { expect, it } from 'vitest';
import { jobProgress } from './batchProgress';
import type { Job } from './types';
const job: Job = {
  id: 'batch',
  projectId: 'project',
  kind: 'ttsBatch',
  status: 'running',
  stage: 'ttsGenerate',
  progress: 0.5,
  error: null,
  logs: [],
  batch: { total: 4, completed: 1, succeeded: 1, failed: 0, skipped: 2, currentLineId: 'line' },
};
it('combines completed items with current worker progress and preserves progress on cancellation', () => {
  expect(jobProgress(job)).toBe(0.375);
  expect(
    jobProgress({ ...job, status: 'cancelled', batch: { ...job.batch!, currentLineId: null } }),
  ).toBe(0.25);
  expect(jobProgress({ ...job, batch: null })).toBe(0.5);
});
it('clamps worker progress and safely represents queued and empty lots', () => {
  expect(jobProgress({ ...job, progress: 4 })).toBe(0.5);
  expect(jobProgress({ ...job, progress: null })).toBe(0.25);
  expect(jobProgress({ ...job, batch: { ...job.batch!, total: 0 } })).toBe(0);
});
