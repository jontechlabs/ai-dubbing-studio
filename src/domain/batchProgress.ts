import type { Job } from './types';
export function jobProgress(job: Job) {
  if (!job.batch) return job.progress;
  if (!job.batch.total) return 0;
  return Math.min(
    1,
    (job.batch.completed +
      (job.batch.currentLineId ? Math.max(0, Math.min(1, job.progress ?? 0)) : 0)) /
      job.batch.total,
  );
}
