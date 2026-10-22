import type { Job } from './types';
export type JobNotice = { key: string; job: Job; phase: 'started' | 'finished' };
export class JobTransitions {
  private seen = new Map<string, { started: boolean; terminal: boolean }>();
  seed(jobs: Job[]) {
    for (const job of jobs)
      if (!this.seen.has(job.id))
        this.seen.set(job.id, {
          started: job.status !== 'queued',
          terminal: ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.status),
        });
  }
  accept(job: Job): JobNotice | null {
    const state = this.seen.get(job.id) ?? { started: false, terminal: false };
    if (state.terminal) return null;
    const terminal = ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.status);
    const start = job.status === 'running' && !state.started;
    this.seen.set(job.id, { started: state.started || start, terminal });
    if (!terminal && !start) return null;
    return {
      key: `${job.id}:${terminal ? 'end' : 'start'}`,
      job,
      phase: terminal ? 'finished' : 'started',
    };
  }
}
