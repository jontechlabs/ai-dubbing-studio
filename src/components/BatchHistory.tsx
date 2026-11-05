import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { History, RefreshCw } from 'lucide-react';
import type { Job, Project } from '../domain/types';
import { voiceVariant } from '../domain/voiceEngines';
import * as bridge from '../services/bridge';
import { Modal } from './Modal';
import { BatchRecovery } from './BatchRecovery';
import { TakeDate } from './TakeDate';

export function BatchHistory({
  project,
  jobs,
  busy,
  startTask,
  snapshot,
  onError,
  onChooseLine,
}: {
  project: Project;
  jobs: Job[];
  busy: boolean;
  startTask: (operation: () => Promise<string>, reportId?: string) => Promise<string>;
  snapshot: () => Promise<Project>;
  onError: (error: string) => void;
  onChooseLine: (id: string) => void;
}) {
  const { t } = useTranslation();
  const scope = JSON.stringify([project.id, project.media?.path, project.languages.target]);
  const [open, setOpen] = useState(false),
    [offset, setOffset] = useState(0),
    [problems, setProblems] = useState(false),
    [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<{
    scope: string;
    entry: bridge.DubbingBatchHistory['items'][number];
    jobId?: string;
  } | null>(null);
  const [result, setResult] = useState<{
    key: string;
    data?: bridge.DubbingBatchHistory;
    error?: string;
  } | null>(null);
  const key = JSON.stringify([scope, offset, problems, revision]);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void bridge
      .dubbingBatchHistory(offset, 20, problems)
      .then((data) => {
        if (!disposed) setResult({ key, data });
      })
      .catch((error) => {
        if (!disposed) setResult({ key, error: String(error) });
      });
    return () => {
      disposed = true;
    };
  }, [open, key, offset, problems]);
  const data = result?.key === key ? result.data : undefined;
  const current = selected?.scope === scope ? selected : null;
  return (
    <div className="batch-history">
      <button
        className="button subtle"
        onClick={() => {
          setOffset(0);
          setRevision((n) => n + 1);
          setOpen(true);
        }}
      >
        <History size={15} />
        {t('batchHistory.title')}
      </button>
      {open && (
        <Modal
          title={t('batchHistory.title')}
          onClose={() => setOpen(false)}
          className="batch-recovery-modal batch-history-modal"
        >
          <p>{t('batchHistory.hint')}</p>
          <div className="batch-recovery-actions">
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={problems}
                onChange={(e) => {
                  setProblems(e.target.checked);
                  setOffset(0);
                }}
              />
              {t('batchHistory.problems')}
            </label>
            <button
              className="icon-button"
              title={t('batchHistory.refresh')}
              aria-label={t('batchHistory.refresh')}
              onClick={() => setRevision((n) => n + 1)}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          {!data && (
            <p role="status">
              {result?.key === key && result.error ? result.error : t('batchHistory.loading')}
            </p>
          )}
          {data && (
            <>
              {data.unreadable > 0 && <p className="warning">{t('batchHistory.unreadable')}</p>}
              {!data.matching && <p>{t('batchHistory.empty')}</p>}
              <div className="batch-recovery-rows">
                {data.items.map((entry) => (
                  <article key={entry.reportId} className="batch-recovery-row">
                    <header>
                      <strong>{voiceVariant(entry.variantId)?.name ?? entry.variantId}</strong>
                      <span>
                        {t(`batchHistory.states.${entry.status}`, { defaultValue: entry.status })}
                      </span>
                    </header>
                    {entry.createdAt ? (
                      <TakeDate value={entry.createdAt} />
                    ) : (
                      <small>{t('takeDate.unknown')}</small>
                    )}
                    <p>
                      {t(
                        (entry.progress.takeCount ?? 1) > 1
                          ? 'batchTakes.summary'
                          : 'batchRecovery.summary',
                        {
                          succeeded: entry.progress.succeeded,
                          failed: entry.progress.failed,
                          pending: Math.max(0, entry.progress.total - entry.progress.completed),
                        },
                      )}
                    </p>
                    {(entry.progress.takeCount ?? 1) > 1 && (
                      <small>{t('batchTakes.perLine', { count: entry.progress.takeCount })}</small>
                    )}
                    {entry.retryCount > 0 && (
                      <small>{t('batchHistory.retries', { count: entry.retryCount })}</small>
                    )}
                    <button
                      className="button subtle"
                      onClick={() => {
                        setSelected({ scope, entry, jobId: entry.activeJobId ?? undefined });
                        setOpen(false);
                      }}
                    >
                      {t('batchHistory.inspect')}
                    </button>
                  </article>
                ))}
              </div>
              <div className="batch-recovery-actions">
                <button
                  className="button subtle"
                  disabled={offset === 0}
                  onClick={() => setOffset((n) => Math.max(0, n - 20))}
                >
                  {t('batchRecovery.previous')}
                </button>
                <span>
                  {Math.min(offset + 1, data.matching)}–{Math.min(offset + 20, data.matching)} /{' '}
                  {data.matching}
                </span>
                <button
                  className="button subtle"
                  disabled={offset + 20 >= data.matching}
                  onClick={() => setOffset((n) => n + 20)}
                >
                  {t('batchRecovery.next')}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
      {current && (
        <BatchRecovery
          key={scope + current.entry.reportId}
          initiallyOpen
          reportId={current.entry.reportId}
          job={jobs.find((j) => j.id === current.jobId)}
          starting={false}
          project={project}
          busy={busy}
          snapshot={snapshot}
          onError={onError}
          onChooseLine={onChooseLine}
          onClose={() => setSelected(null)}
          onDismiss={() => setSelected(null)}
          startTask={async (operation, reportId) => {
            const jobId = await startTask(operation, reportId);
            setSelected((s) => (s?.scope === scope ? { ...s, jobId } : s));
            return jobId;
          }}
        />
      )}
    </div>
  );
}
