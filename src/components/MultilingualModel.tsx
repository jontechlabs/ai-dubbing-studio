import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as bridge from '../services/bridge';

export function MultilingualModel({
  id,
  name,
  installed,
  size,
  busy,
  completion,
  onStarted,
  onError,
}: {
  id: string;
  name: string;
  installed?: boolean;
  size?: number;
  busy: boolean;
  completion: string;
  onStarted: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [space, setSpace] = useState<bridge.VoiceInstallSpace | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(false);
  const [working, setWorking] = useState(false);
  const refresh = useCallback(async () => {
    setChecking(true);
    setError(false);
    try {
      const value = await bridge.voiceInstallSpace(id);
      setSpace(value);
      return value;
    } catch {
      setSpace(null);
      setError(true);
      return null;
    } finally {
      setChecking(false);
    }
  }, [id]);
  useEffect(() => {
    if (bridge.native) void refresh();
  }, [completion, refresh]);
  return (
    <section className="model-card multilingual-model">
      <h3>{name}</h3>
      <p className="model-state">
        {t(
          installed === undefined
            ? 'phase6Checking'
            : installed
              ? 'modelInstalled'
              : 'ttsNotInstalled',
        )}
      </p>
      <p>{t(id === 'voxcpm2-bf16' ? 'voxcpmGenerationHint' : 'chatterboxGenerationHint')}</p>
      <p className="panel-description">{t('multilingualHardwareHint')}</p>
      {size !== undefined && (
        <small>
          {(size / 1024 ** 3).toFixed(2)} GiB · {t('phase6ModelSize')}
        </small>
      )}
      <div className="drama-space" aria-busy={checking}>
        <strong>{t('dramaSpaceTitle')}</strong>
        {space && (
          <>
            <code className="storage-path">{space.path}</code>
            <p>
              {t('dramaSpaceValues', {
                available: (space.availableBytes / 1024 ** 3).toFixed(2),
                required: (space.requiredBytes / 1024 ** 3).toFixed(2),
              })}
            </p>
            <p className={space.enough ? 'model-state' : 'warning'} role="status">
              {t(space.enough ? 'dramaSpaceEnough' : 'dramaSpaceMissing', {
                missing: (
                  Math.max(0, space.requiredBytes - space.availableBytes) /
                  1024 ** 3
                ).toFixed(2),
              })}
            </p>
            <small>
              {t('dramaSpaceDetails', {
                models: (space.modelBytes / 1024 ** 3).toFixed(2),
                downloads: (space.downloadBytes / 1024 ** 3).toFixed(2),
                runtime: (space.runtimeBytes / 1024 ** 3).toFixed(2),
                margin: (space.marginBytes / 1024 ** 3).toFixed(2),
              })}
            </small>
          </>
        )}
        {error && (
          <p className="warning" role="status">
            {t('dramaSpaceError')}
          </p>
        )}
        <button
          className="text-button"
          disabled={checking || working}
          onClick={() => void refresh()}
        >
          {t(checking ? 'dramaSpaceChecking' : 'dramaSpaceRefresh')}
        </button>
        <p className="panel-description">{t('multilingualRuntimeHint')}</p>
      </div>
      <button
        className="button accent wide"
        disabled={!bridge.native || busy || checking || working || !space?.enough}
        onClick={async () => {
          setWorking(true);
          try {
            if (!(await refresh())?.enough) return;
            await bridge.installVoiceRuntime(id);
            onStarted();
          } catch (e) {
            onError(String(e));
          } finally {
            setWorking(false);
          }
        }}
      >
        {t(installed ? 'phase6Repair' : 'phase6Install')}
      </button>
    </section>
  );
}
