import { Download, LoaderCircle, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Updater } from '../hooks/useUpdater';
import { APP_VERSION } from '../domain/project';
import { native } from '../services/bridge';
export function UpdateSettings({ updater, busy }: { updater: Updater; busy: boolean }) {
  const { t } = useTranslation();
  const working = ['checking', 'downloading', 'installing'].includes(updater.state);
  return (
    <div className="settings-section">
      <h3>{t('updatesTitle')}</h3>
      <p>{t('updatesVersion', { version: APP_VERSION })}</p>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={updater.automatic}
          disabled={!native || working}
          onChange={(event) => updater.setAutomatic(event.target.checked)}
        />
        {t('updatesAutomatic')}
      </label>
      <button
        className="button subtle"
        disabled={!native || working}
        onClick={() => void updater.checkNow()}
      >
        {working ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
        {t('updatesCheck')}
      </button>
      {updater.state === 'current' && <p role="status">{t('updatesCurrent')}</p>}
      {updater.available && (
        <>
          <p className="update-available" role="status">
            {t('updatesAvailable', { version: updater.available.version })}
          </p>
          <p className="release-note">{updater.available.body}</p>
          {updater.state !== 'downloaded' && (
            <button
              className="button accent wide"
              disabled={working}
              onClick={() => void updater.download()}
            >
              <Download size={15} />
              {t('updatesDownload')}
            </button>
          )}
        </>
      )}
      {updater.state === 'downloading' && (
        <progress max="1" value={updater.progress ?? undefined} aria-label={t('updatesDownload')} />
      )}
      {updater.state === 'downloaded' && (
        <>
          <p>{t('updatesVerified')}</p>
          <button
            className="button accent wide"
            disabled={busy || working}
            onClick={() => void updater.install()}
          >
            {t('updatesInstall')}
          </button>
          {busy && <p className="warning">{t('updatesWaitJobs')}</p>}
        </>
      )}
      {updater.error && (
        <p className="warning" role="alert">
          {t('updatesError')}
        </p>
      )}
      <p className="panel-description">{t('updatesHint')}</p>
    </div>
  );
}
