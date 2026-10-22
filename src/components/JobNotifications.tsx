import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, Terminal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { JobTransitions, type JobNotice } from '../domain/jobNotifications';
import type { Job } from '../domain/types';
import { formatJobDuration } from '../domain/jobTiming';

export function JobNotifications({ onOpen }: { onOpen: () => void }) {
  const transitions = useRef(new JobTransitions());
  const [notices, setNotices] = useState<JobNotice[]>([]);
  useEffect(() => {
    const receive = (event: Event) => {
      const notice = transitions.current.accept((event as CustomEvent<Job>).detail);
      if (notice)
        setNotices((current) =>
          [...current.filter((n) => n.job.id !== notice.job.id), notice].slice(-3),
        );
    };
    const restore = (event: Event) =>
      transitions.current.seed((event as CustomEvent<Job[]>).detail);
    document.addEventListener('studio-job-event', receive);
    document.addEventListener('studio-jobs-restored', restore);
    return () => {
      document.removeEventListener('studio-job-event', receive);
      document.removeEventListener('studio-jobs-restored', restore);
    };
  }, []);
  return (
    <aside className="job-notifications" aria-label="Notifications">
      {notices.map((n) => (
        <JobToast
          key={n.key}
          notice={n}
          onOpen={onOpen}
          onClose={() => setNotices((items) => items.filter((item) => item.key !== n.key))}
        />
      ))}
    </aside>
  );
}
function JobToast({
  notice,
  onOpen,
  onClose,
}: {
  notice: JobNotice;
  onOpen: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [paused, setPaused] = useState(false);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => close.current(), notice.phase === 'started' ? 2800 : 5500);
    return () => clearTimeout(timer);
  }, [notice.phase, paused]);
  const started = notice.phase === 'started',
    success = notice.job.status === 'succeeded';
  return (
    <div
      className={`job-notice ${notice.job.status}`}
      role="status"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setPaused(false);
      }}
    >
      {started ? (
        <LoaderCircle size={15} className="spin" />
      ) : success ? (
        <Check size={15} />
      ) : (
        <Terminal size={15} />
      )}
      <div>
        <strong>
          {t(
            started
              ? 'noticeStarted'
              : success
                ? 'noticeSucceeded'
                : notice.job.status === 'failed'
                  ? 'noticeFailed'
                  : 'noticeCancelled',
          )}
        </strong>
        <span>
          {t(`jobKinds.${notice.job.kind}`, { defaultValue: t('noticeTask') })}
          {!started && notice.job.timing
            ? ` · ${formatJobDuration(notice.job.timing.elapsedMs)}`
            : ''}
        </span>
        <button
          className="text-button"
          onClick={() => {
            onOpen();
            onClose();
          }}
        >
          {t('noticeOpen')}
        </button>
      </div>
      <button className="notice-close" aria-label={t('noticeDismiss')} onClick={onClose}>
        <X size={13} />
      </button>
    </div>
  );
}
