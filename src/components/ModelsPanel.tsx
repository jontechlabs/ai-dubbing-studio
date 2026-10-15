import { useEffect, useState } from 'react';
import { Download, RefreshCw, AudioLines, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Job, Project } from '../domain/types';
import * as bridge from '../services/bridge';
import { futureVoiceProviders } from '../domain/providers';
import { VoiceVariantSettings } from './VoiceVariantSettings';
export function ModelsPanel({
  project,
  jobs,
  onEdit,
  showJobs,
  onAudio,
  onError,
}: {
  project: Project | null;
  jobs: Job[];
  onEdit: (update: (project: Project) => Project) => void;
  showJobs: () => void;
  onAudio: () => void;
  onError: (error: string) => void;
}) {
  const { t } = useTranslation(),
    [bandit, setBandit] = useState<{ installed: boolean } | null>(null),
    [speakers, setSpeakers] = useState<{ installed: boolean; sizeBytes: number } | null>(null),
    [working, setWorking] = useState(false);
  const completion = jobs
    .filter(
      (job) =>
        ['runtime', 'speakerInstall', 'modelMove'].includes(job.kind) &&
        ['succeeded', 'failed', 'cancelled'].includes(job.status),
    )
    .map((job) => `${job.id}:${job.status}`)
    .join(',');
  const busy = jobs.some((job) => ['running', 'queued', 'paused'].includes(job.status));
  useEffect(() => {
    let disposed = false;
    if (bridge.native) {
      void bridge
        .separationStatus()
        .then((value) => {
          if (!disposed) setBandit(value);
        })
        .catch((error) => {
          if (!disposed) onError(String(error));
        });
      void bridge
        .speakerStatus()
        .then((value) => {
          if (!disposed) setSpeakers(value);
        })
        .catch((error) => {
          if (!disposed) onError(String(error));
        });
    }
    return () => {
      disposed = true;
    };
  }, [completion, onError]);
  return (
    <div className="panel-body models-panel">
      <p className="panel-description">{t('modelsHint')}</p>
      <div className="model-card">
        <h3>
          <AudioLines size={16} />
          Bandit v2 Multilingual
        </h3>
        <span className="model-state">
          {t(bandit?.installed ? 'modelInstalled' : 'modelNotInstalled')}
        </span>
        <p>{t('modelBanditHint')}</p>
        <button className="button subtle wide" onClick={onAudio}>
          {t('modelConfigureBandit')}
        </button>
      </div>
      <div className="model-card">
        <h3>
          <Users size={16} />
          3D-Speaker + Silero VAD
        </h3>
        <span className="model-state">
          {t(speakers?.installed ? 'modelInstalled' : 'modelNotInstalled')}
        </span>
        <p>{t('modelSpeakerHint')}</p>
        <small>
          {speakers ? Math.ceil(speakers.sizeBytes / 1024 / 1024) : 71} MiB · CPU · sherpa-onnx
          1.13.8
        </small>
        <button
          className="button accent wide"
          disabled={!bridge.native || busy || working}
          onClick={() => {
            setWorking(true);
            void bridge
              .installSpeakerRuntime()
              .then(showJobs)
              .catch((error) => onError(String(error)))
              .finally(() => setWorking(false));
          }}
        >
          {speakers?.installed ? <RefreshCw size={15} /> : <Download size={15} />}{' '}
          {t(speakers?.installed ? 'modelRepairSpeakers' : 'modelInstallSpeakers')}
        </button>
      </div>
      <div className="model-card">
        <h3>{t('modelVoiceTitle')}</h3>
        <p>{t('voiceStatusHint')}</p>
        <label className="field">
          <span>{t('modelVoicePreference')}</span>
          <select
            aria-label={t('modelVoicePreference')}
            value={project?.modelPreferences?.ttsProviderId ?? ''}
            disabled={!project}
            onChange={(event) =>
              onEdit((p) => ({
                ...p,
                formatVersion: Math.max(p.formatVersion, 3),
                modelPreferences: {
                  ttsProviderId: event.target.value || null,
                  voiceVariantId: null,
                },
              }))
            }
          >
            <option value="">{t('modelNoPreference')}</option>
            {futureVoiceProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name} · {t(`modelPhase${provider.phase}`)}
              </option>
            ))}
          </select>
        </label>
        <p className="panel-description">{t('modelVoiceHint')}</p>
        {project && <VoiceVariantSettings project={project} onEdit={onEdit} />}
      </div>
    </div>
  );
}
