import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project, Job } from '../domain/types';
import { auditFresh, auditTags, currentAuditRows } from '../domain/dubbingAudit';
import { audioTracks, trackLabel } from '../domain/audio';
import { Modal } from './Modal';
import { CurrentJobProgress } from './CurrentJobProgress';
import * as bridge from '../services/bridge';
export function DubbingAuditPanel({
  project,
  jobs,
  busy,
  snapshot,
  onClose,
  onSelect,
}: {
  project: Project;
  jobs: Job[];
  busy: boolean;
  snapshot: () => Promise<Project>;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [voices, setVoices] = useState('both'),
    [track, setTrack] = useState('auto'),
    [id, setId] = useState<string | null>(null),
    [working, setWorking] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState<{ speakersInstalled: boolean } | null>(null),
    [limit, setLimit] = useState(50);
  useEffect(() => {
    let live = true;
    void bridge
      .dubbingAuditStatus()
      .then((v) => {
        if (live) setStatus(v);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, []);
  const report = project.dubbingAudit,
    fresh = auditFresh(project),
    current = currentAuditRows(project),
    job = jobs.find((j) => j.id === id),
    active = working || (!!job && ['queued', 'running', 'paused'].includes(job.status));
  const run = async () => {
    setWorking(true);
    setError('');
    try {
      const p = await snapshot();
      setId(
        await bridge.analyzeDubbing(p, { voices, sourceTrackId: track === 'auto' ? null : track }),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  };
  return (
    <Modal title={t('audit.title')} onClose={onClose} className="dubbing-audit-modal">
      <p className="panel-description">{t('audit.hint')}</p>
      <label className="field">
        <span>{t('audit.voices')}</span>
        <select value={voices} disabled={active} onChange={(e) => setVoices(e.target.value)}>
          {['both', 'dubbing', 'source', 'off'].map((v) => (
            <option key={v} value={v}>
              {t(`audit.mode.${v}`)}
            </option>
          ))}
        </select>
      </label>
      {voices !== 'off' && (
        <p className="panel-description">
          {t(
            status === null
              ? 'audit.loading'
              : status.speakersInstalled
                ? 'audit.modelReady'
                : 'audit.modelMissing',
          )}
        </p>
      )}
      {['source', 'both'].includes(voices) && (
        <label className="field">
          <span>{t('audit.sourceTrack')}</span>
          <select value={track} disabled={active} onChange={(e) => setTrack(e.target.value)}>
            <option value="auto">{t('ttsAutoReference')}</option>
            {audioTracks(project)
              .filter((tr) => tr.kind !== 'dubbing')
              .map((tr) => (
                <option key={tr.id} value={tr.id}>
                  {t(trackLabel(tr))}
                </option>
              ))}
          </select>
        </label>
      )}
      <button
        className="button primary"
        disabled={busy || active || !project.media}
        onClick={() => void run()}
      >
        {t('audit.run')}
      </button>
      <CurrentJobProgress job={job} starting={working} onError={setError} />
      {error && (
        <p role="alert">
          {t(`errors.${error.replace(/^Error: /, '').split(':')[0]}`, { defaultValue: error })}
        </p>
      )}
      {report && (
        <section aria-label={t('audit.results')}>
          <p>
            {new Date(report.createdAt).toLocaleString()} · {report.rows.length} {t('dialogs')}
          </p>
          {!fresh && <p role="alert">{t('audit.stale')}</p>}
          {report.voicesStatus !== 'completed' && report.voicesStatus !== 'disabled' && (
            <p role="status">{t(`audit.engine.${report.voicesStatus}`)}</p>
          )}
          <div className="audit-summary">
            {auditTags.map((tag) => (
              <span key={tag}>
                {t(`audit.tag.${tag}`)} :{' '}
                {[...current.values()].filter((r) => r.tags.includes(tag)).length}
              </span>
            ))}
          </div>
          {report.rows
            .filter((r) => r.tags.length)
            .slice(0, limit)
            .map((r) => (
              <button
                className="audit-row"
                key={r.lineId}
                onClick={() => {
                  onSelect(r.lineId);
                  onClose();
                }}
              >
                <b>#{project.dialogues.findIndex((l) => l.id === r.lineId) + 1}</b>
                {!current.has(r.lineId) && <small>{t('audit.outdatedRow')}</small>}
                {(r.sourceVoices !== null || r.dubbingVoices !== null) && (
                  <small>
                    {t('audit.voiceCounts', {
                      source: r.sourceVoices ?? '?',
                      dubbing: r.dubbingVoices ?? '?',
                    })}
                  </small>
                )}
                <span>{r.tags.map((tag) => t(`audit.tag.${tag}`)).join(' · ')}</span>
                {r.metrics && (
                  <small>
                    {r.metrics.rmsDb.toFixed(1)} dBFS RMS · {r.metrics.peakDb.toFixed(1)} dBFS{' '}
                    {t('audit.peak')}
                  </small>
                )}
                {r.error && <small>{t('audit.fileError')}</small>}
              </button>
            ))}
          {report.rows.filter((r) => r.tags.length).length > limit && (
            <button className="button subtle" onClick={() => setLimit(limit + 50)}>
              {t('audit.more')}
            </button>
          )}
        </section>
      )}
      <p className="panel-description">{t('audit.caveats')}</p>
    </Modal>
  );
}
