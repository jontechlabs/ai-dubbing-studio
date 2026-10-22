import { expect, it } from 'vitest';
import type { Job } from './types';
import { formatJobDuration, jobElapsedMs } from './jobTiming';

const job: Job = {
  id: 'job',
  projectId: 'project',
  kind: 'tts',
  status: 'running',
  stage: 'ttsGenerate',
  progress: null,
  error: null,
  logs: [],
  timing: { elapsedMs: 1250, observedAtMs: 10000 },
};
it('counts execution between messages and clamps negative wall clock offsets', () => {
  expect(jobElapsedMs(job, 15000)).toBe(6250);
  expect(jobElapsedMs(job, 9999)).toBe(1250);
});
it('freezes during queue, pause, success, failure, cancellation and interruption', () => {
  for (const status of [
    'queued',
    'paused',
    'succeeded',
    'failed',
    'cancelled',
    'interrupted',
  ] as const)
    expect(jobElapsedMs({ ...job, status }, 1e12)).toBe(1250);
});
it('does not invent durations for older or malformed job records', () => {
  expect(jobElapsedMs({ ...job, timing: undefined }, 15000)).toBeNull();
  expect(
    jobElapsedMs({ ...job, timing: { elapsedMs: NaN, observedAtMs: 10000 } }, 15000),
  ).toBeNull();
});
it('formats second, minute and hour boundaries without wrapping days', () => {
  expect(
    [0, -1, 999, 1000, 59999, 60000, 3599999, 3600000, 90061000].map(formatJobDuration),
  ).toEqual([
    '00:00:00',
    '00:00:00',
    '00:00:00',
    '00:00:01',
    '00:00:59',
    '00:01:00',
    '00:59:59',
    '01:00:00',
    '25:01:01',
  ]);
});
