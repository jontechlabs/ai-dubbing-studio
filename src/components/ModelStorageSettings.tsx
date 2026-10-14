import { useEffect, useState } from 'react';
import { FolderOpen, HardDrive, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Job } from '../domain/types';
import * as bridge from '../services/bridge';

export function ModelStorageSettings({
  jobs,
  onError,
}: {
  jobs: Job[];
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<bridge.ModelStorageInfo | null>(null);
  const [path, setPath] = useState('');
  const [working, setWorking] = useState(false);
  const job = jobs.find((job) => job.kind === 'modelMove');
  const completion = jobs
    .filter(
      (job) =>
        job.kind === 'modelMove' &&
        ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.status),
    )
    .map((job) => `${job.id}:${job.status}`)
    .join('|');
  const busy = working || jobs.some((job) => ['queued', 'running', 'paused'].includes(job.status));
  useEffect(() => {
    if (!bridge.native) return;
    let disposed = false;
    void bridge
      .modelStorageInfo()
      .then((value) => {
        if (!disposed) {
          setInfo(value);
          setPath(value.path);
        }
      })
      .catch((error) => {
        if (!disposed) onError(String(error));
      });
    return () => {
      disposed = true;
    };
  }, [completion, onError]);
  return (
    <section className="settings-section model-storage">
      <h3>
        <HardDrive size={16} /> {t('modelStorageTitle')}
      </h3>
      <p className="panel-description">{t('modelStorageHint')}</p>
      <label className="field">
        <span>{t('modelStoragePath')}</span>
        <input
          value={path}
          disabled={!bridge.native || busy || !info}
          onChange={(event) => setPath(event.target.value)}
        />
      </label>
      {info && (
        <p className="panel-description model-storage-current">
          {t('modelStorageCurrent')} <code>{info.path}</code>
        </p>
      )}
      <div className="model-storage-actions">
        <button
          className="button subtle"
          disabled={!bridge.native || busy}
          onClick={() => {
            void bridge
              .pickModelDirectory()
              .then((value) => {
                if (value) setPath(value);
              })
              .catch((error) => onError(String(error)));
          }}
        >
          <FolderOpen size={15} /> {t('chooseFolder')}
        </button>
        <button
          className="button accent"
          disabled={!info || busy || !path.trim() || path.trim() === info.path}
          onClick={() => {
            setWorking(true);
            void bridge
              .changeModelStorage(path.trim())
              .catch((error) => onError(String(error)))
              .finally(() => setWorking(false));
          }}
        >
          {working ? <LoaderCircle size={15} className="spin" /> : <HardDrive size={15} />}{' '}
          {t('modelStorageMove')}
        </button>
        {info && info.path !== info.defaultPath && (
          <button className="text-button" disabled={busy} onClick={() => setPath(info.defaultPath)}>
            {t('modelStorageDefault')}
          </button>
        )}
      </div>
      {job && (
        <div className="model-storage-progress" role="status" aria-live="polite">
          <strong>
            {t(
              job.status === 'succeeded'
                ? 'modelStorageMoved'
                : job.status === 'failed'
                  ? 'jobFailed'
                  : job.status === 'cancelled' || job.status === 'interrupted'
                    ? 'jobCancelled'
                    : `jobStages.${job.stage}`,
            )}
          </strong>
          <progress
            value={job.progress ?? undefined}
            max="1"
            aria-label={t('modelStorageProgress')}
          />
          {job.progress !== null && <span>{Math.round(job.progress * 100)}%</span>}
          {['queued', 'running'].includes(job.status) && job.stage !== 'modelCommit' && (
            <button
              className="text-button"
              onClick={() => void bridge.cancelJob(job.id).catch((error) => onError(String(error)))}
            >
              {t('cancel')}
            </button>
          )}
          {job.error && (
            <p>{t(`errors.${job.error.split(':')[0]}`, { defaultValue: job.error })}</p>
          )}
          {!!job.logs.some((log) => log.startsWith('Old installation retained:')) && (
            <p className="warning">{t('modelStorageCleanupWarning')}</p>
          )}
        </div>
      )}
      {!bridge.native && <p className="panel-description">{t('errors.DESKTOP_REQUIRED')}</p>}
    </section>
  );
}
