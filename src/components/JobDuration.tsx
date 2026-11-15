import { useEffect, useMemo, useState } from 'react';
import { Clock3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Job } from '../domain/types';
import { formatJobDuration, jobElapsedMs } from '../domain/jobTiming';
import { remainingGenerationMs } from '../domain/generationTiming';

export function JobDuration({ job }: { job: Job }) {
  const { t } = useTranslation();
  // Anchor to a monotonic browser clock so changing Windows time while a task
  // runs cannot change the displayed duration. Native snapshots are monotonic too.
  const anchor = useMemo(
    () => ({ elapsed: jobElapsedMs(job, Date.now()), at: performance.now() }),
    [job],
  );
  const [tick, setTick] = useState(() => performance.now());
  const running = job.status === 'running' && anchor.elapsed !== null;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setTick(performance.now()), 250);
    return () => window.clearInterval(timer);
  }, [running]);
  const elapsed =
    anchor.elapsed === null ? null : anchor.elapsed + (running ? Math.max(0, tick - anchor.at) : 0);
  const remaining = remainingGenerationMs(job, elapsed);
  return (
    <>
      <span
        className="job-duration"
        title={t(elapsed === null ? 'jobDurationUnknownHint' : 'jobDurationHint')}
      >
        <Clock3 size={13} aria-hidden="true" />
        <time
          role="timer"
          aria-live="off"
          dateTime={elapsed === null ? undefined : `PT${(elapsed / 1000).toFixed(3)}S`}
        >
          {t(running ? 'jobElapsed' : 'jobDuration', {
            time: elapsed === null ? '—' : formatJobDuration(elapsed),
          })}
        </time>
      </span>
      {remaining !== null && (
        <small
          className="job-estimate"
          aria-live="off"
          title={t('generationTiming.estimateHint', { count: job.estimate?.sampleCount ?? 0 })}
        >
          {remaining === 'learning'
            ? t('generationTiming.learning')
            : remaining === 'overrun'
              ? t('generationTiming.overrun')
              : t('generationTiming.remaining', {
                  time: formatJobDuration(Math.ceil(remaining / 1000) * 1000),
                })}
        </small>
      )}
    </>
  );
}
