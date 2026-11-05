import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import type { Job, Project } from '../domain/types';
import { dialogueText } from '../domain/subtitles';
import { formatTime } from '../domain/time';
import * as bridge from '../services/bridge';
import { Modal } from './Modal';
import { TakeDate } from './TakeDate';

export function BatchRecovery({
  job,
  starting,
  reportId,
  project,
  busy,
  startTask,
  snapshot,
  onDismiss,
  onError,
  onChooseLine,
  initiallyOpen = false,
  onClose,
}: {
  job: Job | undefined;
  starting: boolean;
  reportId: string;
  project: Project;
  busy: boolean;
  startTask: (operation: () => Promise<string>, reportId?: string) => Promise<string>;
  snapshot: () => Promise<Project>;
  onDismiss: () => void;
  onError: (error: string) => void;
  onChooseLine?: (id: string) => void;
  initiallyOpen?: boolean;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(initiallyOpen),
    [offset, setOffset] = useState(0),
    [all, setAll] = useState(false),
    [checked, setChecked] = useState<Record<number, string>>({}),
    [working, setWorking] = useState(false),
    [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    data?: bridge.DubbingBatchReport;
    error?: string;
  } | null>(null);
  const key = JSON.stringify([
    project.id,
    reportId,
    job?.id,
    job?.status,
    job?.batch?.completed,
    job?.batch?.failed,
    job?.batch?.currentLineId,
    offset,
    all,
    revision,
  ]);
  useEffect(() => {
    let disposed = false;
    void bridge
      .dubbingBatchReport(reportId, offset, 25, !all)
      .then((data) => {
        if (!disposed) setResult({ key, data });
      })
      .catch((error) => {
        if (!disposed) setResult({ key, error: String(error) });
      });
    return () => {
      disposed = true;
    };
  }, [key, reportId, offset, all]);
  const data = result?.key === key ? result.data : null;
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  const active = starting || (!!job && ['queued', 'running', 'paused'].includes(job.status));
  const retry = async (
    scope: 'failed' | 'unfinished' | 'selected',
    ids: string[] = [],
    indices: number[] = [],
  ) => {
    setWorking(true);
    try {
      await startTask(async () => {
        await snapshot();
        return bridge.retryDubbingBatch(data?.reportId ?? reportId, {
          scope,
          lineIds: multiple ? [] : ids,
          ...(multiple && scope === 'selected' ? { itemIndices: indices } : {}),
        });
      }, data?.reportId ?? reportId);
      setChecked({});
      setOffset(0);
    } catch (error) {
      onError(String(error));
    } finally {
      setWorking(false);
      setRevision((n) => n + 1);
    }
  };
  const disabled = busy || working || active;
  const progress = data?.progress;
  const multiple = (progress?.takeCount ?? job?.batch?.takeCount ?? 1) > 1;
  const remaining = progress ? Math.max(0, progress.total - progress.completed) : 0;
  const controls = (
    <>
      <button
        className="button subtle"
        disabled={disabled || !progress?.failed}
        onClick={() => void retry('failed')}
      >
        {t('batchRecovery.retryFailed', { count: progress?.failed ?? 0 })}
      </button>
      {remaining > 0 && (
        <button
          className="button subtle"
          disabled={disabled}
          onClick={() => void retry('unfinished')}
        >
          {t('batchRecovery.retryRemaining')}
        </button>
      )}
      <button
        className="button accent"
        disabled={disabled || !Object.keys(checked).length}
        onClick={() =>
          void retry('selected', Object.values(checked), Object.keys(checked).map(Number))
        }
      >
        {t('batchRecovery.retrySelected', { count: Object.keys(checked).length })}
      </button>
    </>
  );
  return (
    <div className="batch-recovery">
      <button className="text-button" onClick={() => setOpen(true)}>
        {t('batchRecovery.details', { failed: progress?.failed ?? job?.batch?.failed ?? 0 })}
      </button>
      {open && (
        <Modal title={t('batchRecovery.title')} onClose={close} className="batch-recovery-modal">
          <p>{t('batchRecovery.hint')}</p>
          {progress && (
            <p role="status">
              {t(multiple ? 'batchTakes.summary' : 'batchRecovery.summary', {
                succeeded: progress.succeeded,
                failed: progress.failed,
                pending: remaining,
              })}
            </p>
          )}
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={all}
              onChange={(e) => {
                setAll(e.target.checked);
                setOffset(0);
              }}
            />
            {t('batchRecovery.showAll')}
          </label>
          <div className="batch-recovery-actions">{controls}</div>
          {!data && (
            <p role="status">
              {result?.key === key && result.error ? result.error : t('batchRecovery.loading')}
            </p>
          )}
          {data && (
            <>
              {!data.matching && <p>{t('batchRecovery.empty')}</p>}
              <div className="batch-recovery-rows">
                {data.items.map((row) => {
                  const line = project.dialogues.find((l) => l.id === row.lineId),
                    number = project.dialogues.findIndex((l) => l.id === row.lineId) + 1;
                  const retryable = row.status === 'failed' || row.status === 'pending';
                  const status =
                    active &&
                    row.status === 'pending' &&
                    job?.batch?.currentLineId === row.lineId &&
                    (!multiple || job.batch.currentIndex === row.itemIndex)
                      ? 'running'
                      : row.status;
                  return (
                    <article key={row.itemIndex} className={`batch-recovery-row ${row.status}`}>
                      <header>
                        <input
                          type="checkbox"
                          aria-label={t(multiple ? 'batchTakes.check' : 'batchRecovery.check', {
                            number,
                            take: row.takeIndex,
                          })}
                          checked={checked[row.itemIndex] !== undefined}
                          disabled={!retryable || disabled}
                          onChange={(e) =>
                            setChecked((ids) =>
                              e.target.checked
                                ? { ...ids, [row.itemIndex]: row.lineId }
                                : Object.fromEntries(
                                    Object.entries(ids).filter(
                                      ([i]) => Number(i) !== row.itemIndex,
                                    ),
                                  ),
                            )
                          }
                        />
                        <button
                          className="text-button"
                          disabled={!line || !onChooseLine}
                          onClick={() => {
                            onChooseLine?.(row.lineId);
                            close();
                          }}
                        >
                          {t('batchLine', { number })}
                          {line ? ` · ${formatTime(line.startMs)}` : ''}
                        </button>
                        {multiple && (
                          <span>
                            {t('batchTakes.index', {
                              take: row.takeIndex,
                              count: progress?.takeCount ?? job?.batch?.takeCount ?? 1,
                            })}
                          </span>
                        )}
                        <strong>{t(`batchRecovery.states.${status}`)}</strong>
                        {retryable && (
                          <button
                            className="icon-button"
                            disabled={disabled}
                            aria-label={t(
                              multiple ? 'batchTakes.retry' : 'batchRecovery.retryLine',
                              { number, take: row.takeIndex },
                            )}
                            title={t(multiple ? 'batchTakes.retry' : 'batchRecovery.retryLine', {
                              number,
                              take: row.takeIndex,
                            })}
                            onClick={() => void retry('selected', [row.lineId], [row.itemIndex])}
                          >
                            <RefreshCw size={14} />
                          </button>
                        )}
                      </header>
                      {line && (
                        <p>{dialogueText(project, line, 'target') || t('batchRecovery.missing')}</p>
                      )}
                      {row.error && (
                        <p className="warning">
                          {t(`errors.${row.error.split(':')[0]}`, { defaultValue: row.error })}
                        </p>
                      )}
                      {row.createdAt && <TakeDate value={row.createdAt} />}
                    </article>
                  );
                })}
              </div>
              <div className="batch-recovery-actions">
                <button
                  className="button subtle"
                  disabled={offset === 0}
                  onClick={() => setOffset((n) => Math.max(0, n - 25))}
                >
                  {t('batchRecovery.previous')}
                </button>
                <span>
                  {Math.min(offset + 1, data.matching)}–{Math.min(offset + 25, data.matching)} /{' '}
                  {data.matching}
                </span>
                <button
                  className="button subtle"
                  disabled={offset + 25 >= data.matching}
                  onClick={() => setOffset((n) => n + 25)}
                >
                  {t('batchRecovery.next')}
                </button>
              </div>
            </>
          )}
          <div className="dialogue-manage-actions">
            <button className="button subtle" onClick={close}>
              {t('close')}
            </button>
            {!active && (
              <button
                className="button subtle"
                onClick={() => {
                  setOpen(false);
                  onDismiss();
                }}
              >
                {t('batchRecovery.dismiss')}
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
