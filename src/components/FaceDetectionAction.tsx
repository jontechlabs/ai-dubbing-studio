import { JobDuration } from './JobDuration';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Job, Project } from '../domain/types';
import * as bridge from '../services/bridge';

export function FaceDetectionAction({
  project,
  jobs,
  selection,
  busy,
  ready,
  snapshot,
  onApply,
  onError,
}: {
  project: Project;
  jobs: Job[];
  selection: bridge.InpaintBatchSelection;
  busy: boolean;
  ready: boolean;
  snapshot: () => Promise<Project>;
  onApply: (crops: bridge.InpaintBatchSelection['crops']) => void;
  onError: (error: string) => void;
}) {
  const { t } = useTranslation();
  const [profile, setProfile] = useState('auto'),
    [working, setWorking] = useState(false);
  const job = jobs.find((j) => j.kind === 'faceDetection' && j.projectId === project.id);
  const [result, setResult] = useState<{ key: string; value: bridge.FaceProposals } | null>(null);
  const key = job?.id + ':' + project.revision;
  useEffect(() => {
    let disposed = false;
    if (job?.status === 'succeeded')
      void bridge
        .faceDetectionResult(job.id)
        .then((value) => {
          if (!disposed && value) setResult({ key, value });
        })
        .catch((e) => {
          if (!disposed) onError(String(e));
        });
    return () => {
      disposed = true;
    };
  }, [key, job?.id, job?.status, onError]);
  const rows = job?.status === 'succeeded' && result?.key === key ? result.value.items : [];
  const found = rows.filter((r) => r.crop),
    rejected = rows.filter((r) => !r.crop);
  return (
    <section className="face-detection-action">
      <h4>{t('faceDetection')}</h4>
      <p className="panel-description">{t('faceDetectionHint')}</p>
      <label className="field">
        <span>{t('faceProfile')}</span>
        <select
          aria-label={t('faceProfile')}
          value={profile}
          disabled={busy || working}
          onChange={(e) => setProfile(e.target.value)}
        >
          <option value="auto">{t('faceProfileAuto')}</option>
          <option value="live">{t('faceProfileLive')}</option>
          <option value="anime">{t('faceProfileAnime')}</option>
        </select>
      </label>
      <button
        className="button subtle wide"
        disabled={busy || working || !ready}
        onClick={async () => {
          setWorking(true);
          try {
            await snapshot();
            await bridge.detectInpaintFaces(selection, profile);
          } catch (e) {
            onError(String(e));
          } finally {
            setWorking(false);
          }
        }}
      >
        {t('faceDetectBatch')}
      </button>
      {job && ['running', 'queued'].includes(job.status) && (
        <div>
          <p role="status">
            {t('faceDetectProgress')} {Math.round((job.progress ?? 0) * 100)}%
          </p>
          <JobDuration job={job} />
          <button
            className="text-button"
            onClick={() => void bridge.cancelJob(job.id).catch((e) => onError(String(e)))}
          >
            {t('cancel')}
          </button>
        </div>
      )}
      {job?.status === 'failed' && <p role="alert">{t('errors.' + job.error)}</p>}
      {rows.length > 0 && (
        <>
          <p role="status">
            {t('faceDetectionResults', { found: found.length, rejected: rejected.length })}
          </p>
          {rejected.length > 0 && (
            <details>
              <summary>{t('faceManualRequired')}</summary>
              {rejected.map((row) => (
                <p key={row.lineId}>
                  {project.dialogues.findIndex((l) => l.id === row.lineId) + 1} ·{' '}
                  {t('errors.' + (row.reason ?? 'FACE_NOT_FOUND'))}
                </p>
              ))}
            </details>
          )}
          <button
            className="button subtle wide"
            disabled={busy || !found.length}
            onClick={() => onApply(Object.fromEntries(found.map((row) => [row.lineId, row.crop!])))}
          >
            {t('faceApplyProposals', { count: found.length })}
          </button>
          <p className="warning">{t('faceReviewHint')}</p>
        </>
      )}
    </section>
  );
}
