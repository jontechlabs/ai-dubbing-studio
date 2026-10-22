import { it, expect } from 'vitest';
import { JobTransitions } from './jobNotifications';
import type { Job } from './types';
const job: Job = {
  id: 'one',
  projectId: 'p',
  kind: 'tts',
  status: 'queued',
  stage: 'ttsGenerate',
  progress: 0,
  error: null,
  logs: [],
};
it('announces actual execution once, skips progress and pause/resume, then announces completion once', () => {
  const state = new JobTransitions();
  expect(state.accept(job)).toBeNull();
  expect(state.accept({ ...job, status: 'running' })?.phase).toBe('started');
  for (const status of ['running', 'paused', 'running'] as const)
    expect(state.accept({ ...job, status, progress: 0.5 })).toBeNull();
  expect(state.accept({ ...job, status: 'succeeded' })?.phase).toBe('finished');
  expect(state.accept({ ...job, status: 'succeeded' })).toBeNull();
  expect(state.accept({ ...job, status: 'running' })).toBeNull();
});
it('restored historical jobs do not announce starts or past completions', () => {
  const state = new JobTransitions();
  state.seed([
    { ...job, status: 'succeeded' },
    { ...job, id: 'active', status: 'running' },
  ]);
  expect(state.accept({ ...job, status: 'succeeded' })).toBeNull();
  expect(state.accept({ ...job, id: 'active', status: 'running' })).toBeNull();
  expect(state.accept({ ...job, id: 'active', status: 'succeeded' })?.phase).toBe('finished');
});
it('handles queued cancellation, failure and a fresh retry without duplicate notices', () => {
  for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
    const state = new JobTransitions();
    state.accept(job);
    expect(state.accept({ ...job, status })?.phase).toBe('finished');
    expect(state.accept({ ...job, status })).toBeNull();
    expect(state.accept({ ...job, id: 'retry', status: 'running' })?.phase).toBe('started');
  }
});
