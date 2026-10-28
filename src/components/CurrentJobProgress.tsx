import { LoaderCircle, Check, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Job } from '../domain/types';
import { JobDuration } from './JobDuration';
import * as bridge from '../services/bridge';
/** One operation, kept beside the configuration that launched it. */
export function CurrentJobProgress({
  job,
  onError,
}: {
  job: Job | undefined;
  onError: (error: string) => void;
}) {
  const { t } = useTranslation();
  if (!job) return null;
  const active = ['queued', 'running', 'paused'].includes(job.status),
    success = job.status === 'succeeded';
  return (
    <section
      className="current-job-progress"
      aria-label={t('workbench.currentTask')}
      aria-live="polite"
    >
      <strong>
        {active ? (
          <LoaderCircle size={14} className="spin" />
        ) : success ? (
          <Check size={14} />
        ) : (
          <XCircle size={14} />
        )}
        {t(`jobKinds.${job.kind}`, { defaultValue: job.kind })}
      </strong>
      <span>
        {t(
          active
            ? `jobStages.${job.stage}`
            : success
              ? 'jobDone'
              : job.status === 'cancelled'
                ? 'jobCancelled'
                : 'jobFailed',
          { defaultValue: job.stage },
        )}
      </span>
      {active && (
        <progress max={1} value={job.progress ?? undefined} aria-label={t('workbench.progress')} />
      )}
      <JobDuration job={job} />
      {job.error && (
        <p role="alert">{t(`errors.${job.error.split(':')[0]}`, { defaultValue: job.error })}</p>
      )}
      {active && (
        <button
          className="text-button"
          onClick={() => void bridge.cancelJob(job.id).catch((e) => onError(String(e)))}
        >
          {t('cancel')}
        </button>
      )}
      {!!job.logs.length && (
        <details>
          <summary>{t('logs')}</summary>
          <pre>{job.logs.slice(-10).join('\n')}</pre>
        </details>
      )}
    </section>
  );
}
