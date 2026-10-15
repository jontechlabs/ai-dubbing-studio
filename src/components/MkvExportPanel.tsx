import { useState } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Project } from '../domain/types';
import { audioTracks, effectiveGain, trackLabel, dubbingMix } from '../domain/audio';
import { mixReport } from '../domain/mix';
import * as bridge from '../services/bridge';
export function MkvExportPanel({
  project,
  snapshot,
  onEdit,
  onError,
  showJobs,
  busy,
}: {
  project: Project;
  snapshot: () => Promise<Project>;
  onEdit: (update: (p: Project) => Project) => void;
  onError: (error: string) => void;
  showJobs: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [options, setOptions] = useState<bridge.MkvOptions>({
    includeOriginal: true,
    sourceSubtitles: true,
    targetSubtitles: true,
    codec: 'aac',
    allowIncomplete: false,
  });
  const [working, setWorking] = useState(false);
  const report = mixReport(project),
    tracks = audioTracks(project);
  const review = report.missing + report.stale + report.long > 0;
  const audible = tracks.filter((track) => effectiveGain(track, tracks, 1) > 0);
  return (
    <section className="settings-section mkv-export-panel">
      <h3>{t('exportMkvTitle')}</h3>
      <p className="panel-description">{t('exportMkvHint')}</p>
      <div className="runtime-card">
        <strong>{t('mixSummary', { count: report.clips.length })}</strong>
        <p>
          {t('mixAudible')}:{' '}
          {audible
            .map((track) => `${t(trackLabel(track))} ${Math.round(track.gain * 100)}%`)
            .join(' · ') || t('allAudioSilent')}
        </p>
        <p className="panel-description">{t('mixNaturalLength')}</p>
        {!!report.clips.length && (
          <button className="button accent wide" disabled={busy} onClick={() => onEdit(dubbingMix)}>
            {t('prepareDubbingMix')}
          </button>
        )}
        {review && (
          <p className="warning" role="status">
            {t('mixReview', report)}
          </p>
        )}
        {audible.some((track) => track.kind === 'original' || track.role === 'speech') && (
          <p className="warning">{t('mixOriginalWarning')}</p>
        )}
        {!tracks.some((track) => track.role === 'music' || track.role === 'sfx') && (
          <p className="panel-description">{t('mixNoStems')}</p>
        )}
      </div>
      <label className="field">
        <span>{t('exportAudioCodec')}</span>
        <select
          value={options.codec}
          onChange={(e) => setOptions({ ...options, codec: e.target.value as 'aac' | 'flac' })}
        >
          <option value="aac">AAC · 320 kb/s · 48 kHz</option>
          <option value="flac">FLAC · 48 kHz</option>
        </select>
      </label>
      {(['includeOriginal', 'sourceSubtitles', 'targetSubtitles'] as const).map((key) => (
        <label className="checkbox-field" key={key}>
          <input
            type="checkbox"
            checked={options[key]}
            onChange={(e) => setOptions({ ...options, [key]: e.target.checked })}
          />
          {t(`mkv.${key}`)}
        </label>
      ))}
      {review && (
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={options.allowIncomplete}
            onChange={(e) => setOptions({ ...options, allowIncomplete: e.target.checked })}
          />
          {t('mixAcceptReview')}
        </label>
      )}
      <p className="panel-description">{t('mixExportLevels')}</p>
      <button
        className="button accent wide"
        disabled={
          !bridge.native ||
          !project.media ||
          busy ||
          working ||
          (review && !options.allowIncomplete)
        }
        onClick={() => {
          setWorking(true);
          void snapshot()
            .then((p) => bridge.exportMkv(p, options))
            .then((id) => {
              if (id) showJobs();
            })
            .catch((error) => onError(String(error)))
            .finally(() => setWorking(false));
        }}
      >
        {working ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
        {t('exportMkv')}
      </button>
    </section>
  );
}
