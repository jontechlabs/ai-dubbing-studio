import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  graphicsInfo,
  native,
  openGraphicsSettings,
  setGraphicsPreference,
} from '../services/bridge';
export function GraphicsSettings() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof graphicsInfo>> | null>(null);
  const [changed, setChanged] = useState(false),
    [working, setWorking] = useState(false),
    [error, setError] = useState(false);
  useEffect(() => {
    if (native)
      void graphicsInfo()
        .then(setInfo)
        .catch(() => setError(true));
  }, []);
  if (!native) return null;
  return (
    <div className="settings-section">
      <h3>{t('graphicsTitle')}</h3>
      <p className="panel-description">{t('graphicsHint')}</p>
      <label className="field">
        <span>{t('graphicsPreference')}</span>
        <select
          disabled={!info || working}
          value={info?.preference ?? 'auto'}
          onChange={(event) => {
            const choice = event.target.value;
            setWorking(true);
            setError(false);
            void setGraphicsPreference(choice)
              .then(() => {
                setInfo((current) => (current ? { ...current, preference: choice } : current));
                setChanged(true);
              })
              .catch(() => setError(true))
              .finally(() => setWorking(false));
          }}
        >
          <option value="auto">{t('graphicsAuto')}</option>
          <option value="economy">{t('graphicsEconomy')}</option>
          <option value="performance">{t('graphicsPerformance')}</option>
        </select>
      </label>
      {changed && <p className="warning">{t('graphicsRestart')}</p>}
      {info?.adapters.map((adapter, index) => (
        <p key={index} className="adapter-name">
          {adapter.Name}
        </p>
      ))}
      <button
        className="button subtle"
        onClick={() => void openGraphicsSettings().catch(() => setError(true))}
      >
        {t('graphicsOpen')}
      </button>
      {info && <small className="executable-path">{info.executable}</small>}
      {error && (
        <p role="alert" className="warning">
          {t('graphicsError')}
        </p>
      )}
    </div>
  );
}
