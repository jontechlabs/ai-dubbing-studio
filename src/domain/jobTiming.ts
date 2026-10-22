import type { Job } from './types';

/** Extrapolate only active jobs; terminal, queued and paused durations stay fixed. */
export function jobElapsedMs(job: Job, now: number): number | null {
  const timing = job.timing;
  if (!timing || !Number.isFinite(timing.elapsedMs) || !Number.isFinite(timing.observedAtMs))
    return null;
  return (
    Math.max(0, timing.elapsedMs) +
    (job.status === 'running' ? Math.max(0, now - timing.observedAtMs) : 0)
  );
}

/** Hours do not wrap at 24: a long model installation remains readable. */
export function formatJobDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000);
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}
