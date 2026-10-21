import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Job } from '../domain/types';
import { installedVoiceVariants, multilingualVariant } from '../domain/voiceEngines';
import * as bridge from '../services/bridge';
import { DramaModels } from './DramaModels';
import { MultilingualModel } from './MultilingualModel';

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
  const [space, setSpace] = useState<bridge.VoiceInstallSpace | null>(null);
  const [spaceChecking, setSpaceChecking] = useState(false);
  const [spaceError, setSpaceError] = useState(false);
  const checkSpace = useCallback(async () => {
    setSpaceChecking(true);
    setSpaceError(false);
    try {
      const value = await bridge.voiceInstallSpace();
      setSpace(value);
      return value;
    } catch {
      setSpace(null);
      setSpaceError(true);
      return null;
    } finally {
      setSpaceChecking(false);
    }
  }, []);
  const completion = jobs
    .filter((j) => ['ttsInstall', 'modelMove'].includes(j.kind))
    .map((j) => j.id + j.status)
    .join('|');
  const busy = working || jobs.some((j) => ['queued', 'running', 'paused'].includes(j.status));
  useEffect(() => {
    if (bridge.native) void checkSpace();
  }, [checkSpace, completion]);
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
          if (multilingualVariant(variant.id))
            return (
              <MultilingualModel
                key={variant.id}
                id={variant.id}
                name={variant.name}
                installed={state?.installed}
                size={state?.sizeBytes}
                busy={busy}
                completion={completion}
                onStarted={onStarted}
                onError={onError}
              />
            );
          const installButton = (
            <button
              className="button accent wide"
              disabled={
                !bridge.native ||
                busy ||
                (variant.id === 'drama3-comfy-fp8' && (spaceChecking || !space?.enough))
              }
              onClick={async () => {
                setWorking(true);
                try {
                  if (variant.id === 'drama3-comfy-fp8' && !(await checkSpace())?.enough) return;
                  await bridge.installVoiceRuntime(variant.id);
                  onStarted();
                } catch (e) {
                  onError(String(e));
                } finally {
                  setWorking(false);
                }
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
                space={space}
                checking={spaceChecking}
                spaceError={spaceError}
                onCheckSpace={() => void checkSpace()}
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
