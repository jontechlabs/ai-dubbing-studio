import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Job } from '../domain/types';
import { installedVoiceVariants } from '../domain/voiceEngines';
import * as bridge from '../services/bridge';
import { DramaModels } from './DramaModels';

export function VoiceEngineModels({
  jobs,
  onError,
  onStarted,
}: {
  jobs: Job[];
  onError: (message: string) => void;
  onStarted: () => void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<bridge.VoiceStatus | null>(null);
  const [working, setWorking] = useState(false);
  const completion = jobs
    .filter((j) => ['ttsInstall', 'modelMove'].includes(j.kind))
    .map((j) => j.id + j.status)
    .join('|');
  const busy = working || jobs.some((j) => ['queued', 'running', 'paused'].includes(j.status));
  useEffect(() => {
    let disposed = false;
    if (bridge.native)
      void bridge
        .voiceStatus()
        .then((s) => {
          if (!disposed) setStatus(s);
        })
        .catch((e) => {
          if (!disposed) onError(String(e));
        });
    return () => {
      disposed = true;
    };
  }, [completion, onError]);
  return (
    <>
      <p className="panel-description">{t('phase6Profiles')}</p>
      {installedVoiceVariants
        .filter((v) => v.id !== 'cosy3-official')
        .map((variant) => {
          const state = status?.variants.find((v) => v.id === variant.id);
          const installButton = (
            <button
              className="button accent wide"
              disabled={!bridge.native || busy}
              onClick={() => {
                setWorking(true);
                void bridge
                  .installVoiceRuntime(variant.id)
                  .then(onStarted)
                  .catch((e) => onError(String(e)))
                  .finally(() => setWorking(false));
              }}
            >
              {t(
                variant.id === 'drama3-comfy-fp8'
                  ? state?.installed
                    ? 'dramaRepair'
                    : 'dramaInstall'
                  : state?.installed
                    ? 'phase6Repair'
                    : 'phase6Install',
              )}
            </button>
          );
          if (variant.id === 'drama3-comfy-fp8')
            return (
              <DramaModels
                key={variant.id}
                installed={state?.installed}
                installButton={installButton}
              />
            );
          return (
            <div className="model-card" key={variant.id}>
              <h3>{variant.name}</h3>
              <p>{t(state?.installed ? 'modelInstalled' : 'ttsNotInstalled')}</p>
              <p className="panel-description">
                {t(variant.backend === 'vulkan' ? 'phase6Gguf' : 'phase6Fp8')}
              </p>
              {variant.providerId.startsWith('fish') && (
                <p className="warning">{t('phase6FishLicense')}</p>
              )}
              {state && (
                <small>
                  {(state.sizeBytes / 1024 ** 3).toFixed(2)} GiB · {t('phase6ModelSize')}
                </small>
              )}
              {installButton}
            </div>
          );
        })}
    </>
  );
}
