import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Timer } from 'lucide-react';
import type { Job } from '../domain/types';
import { type WorkForecast, workRemaining } from '../domain/workEstimate';
import { formatJobDuration, jobElapsedMs } from '../domain/jobTiming';

export function WorkEstimate({
  forecast,
  jobs,
  scope,
  paused = false,
}: {
  forecast: WorkForecast | null | undefined;
  jobs: Job[];
  scope: 'batch' | 'workflow' | 'queue';
  paused?: boolean;
}) {
  const { t } = useTranslation();
  const job = jobs.find((j) => j.id === forecast?.active?.jobId);
  const anchor = useMemo(
    () => ({
      elapsed:
        job && ['running', 'queued', 'paused'].includes(job.status)
          ? jobElapsedMs(job, Date.now())
          : null,
      at: performance.now(),
    }),
    [job],
  );
  const [tick, setTick] = useState(() => performance.now());
  const running = job?.status === 'running' && anchor.elapsed !== null;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setTick(performance.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (!forecast) return null;
  const elapsed =
    anchor.elapsed === null ? null : anchor.elapsed + (running ? Math.max(0, tick - anchor.at) : 0);
  const result = workRemaining(forecast, elapsed);
  const label = t('workEstimate.' + scope),
    time = formatJobDuration(Math.ceil(result.ms / 1000) * 1000);
  return (
    <small
      className={'work-estimate work-estimate-' + scope}
      aria-live="off"
      title={t('workEstimate.hint')}
    >
      <Timer size={13} aria-hidden="true" />
      <span>
        {result.unknown > 0
          ? result.known > 0
            ? t('workEstimate.partial', { label, time, count: result.unknown })
            : t('workEstimate.learning', { label, count: result.unknown })
          : result.known > 0
            ? t('workEstimate.remaining', { label, time })
            : t('workEstimate.finalizing', { label })}
        {result.overrun && <> · {t('workEstimate.overrun')}</>}
        {paused && !running && <> · {t('workEstimate.paused')}</>}
      </span>
    </small>
  );
}
