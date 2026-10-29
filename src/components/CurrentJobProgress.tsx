import { LoaderCircle, Check, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Job } from '../domain/types';
import { JobDuration } from './JobDuration';
import * as bridge from '../services/bridge';
/** One operation, kept beside the configuration that launched it. */
export function CurrentJobProgress({
  job,
  onError,
  starting = false,
  error,
  onRetry,
}: {
  job: Job | undefined;
  onError: (error: string) => void;
  starting?: boolean;
  error?: string;
  onRetry?: (id: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  if (!job)
    return starting || error ? (
      <section
        className="current-job-progress"
        aria-label={t('workbench.currentTask')}
        aria-live="polite"
      >
        <strong>
          {starting ? <LoaderCircle size={14} className="spin" /> : <XCircle size={14} />}
          {t(starting ? 'workbench.startingTask' : 'jobFailed')}
        </strong>
        {starting && <progress aria-label={t('workbench.progress')} />}
        {error && (
          <p role="alert">
            {t(`errors.${error.replace(/^Error: /, '').split(':')[0]}`, { defaultValue: error })}
          </p>
        )}
      </section>
    ) : null;
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
      {job.batch && <span>{t('batchJobSummary', job.batch)}</span>}
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
      {!active && !success && onRetry && (
        <button
          className="text-button"
          onClick={() => void onRetry(job.id).catch((e) => onError(String(e)))}
        >
          {t('retry')}
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
