import { useEffect, useState } from 'react';
import { HardDrive, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as bridge from '../services/bridge';
import { useModelRevision } from '../hooks/useModelRevision';
import { IconButton } from './IconButton';
import { Modal } from './Modal';

export function ModelManager({
  busy,
  onError,
}: {
  busy: boolean;
  onError: (error: string) => void;
}) {
  const { t, i18n } = useTranslation(),
    revision = useModelRevision();
  const [open, setOpen] = useState(false),
    [rows, setRows] = useState<bridge.ManagedModel[]>([]),
    [loading, setLoading] = useState(false),
    [working, setWorking] = useState(false),
    [refresh, setRefresh] = useState(0),
    [error, setError] = useState(''),
    [removeError, setRemoveError] = useState(''),
    [chosen, setChosen] = useState<bridge.ManagedModel | null>(null),
    [notice, setNotice] = useState('');
  useEffect(() => {
    let disposed = false;
    if (open && bridge.native) {
      setLoading(true);
      setError('');
      void bridge
        .managedModels()
        .then((v) => {
          if (!disposed) setRows(v);
        })
        .catch((e) => {
          if (!disposed) setError(String(e));
        })
        .finally(() => {
          if (!disposed) setLoading(false);
        });
    }
    return () => {
      disposed = true;
    };
  }, [open, refresh, revision]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const size = (bytes: number) =>
    new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 1 }).format(
      bytes / 1024 ** 2,
    ) +
    ' ' +
    (i18n.resolvedLanguage === 'fr' ? 'Mio' : 'MiB');
  const present = rows.filter((m) => m.present);
  return (
    <details className="model-manager" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <HardDrive size={15} />
        {t('modelManage.title')}
      </summary>
      {open && (
        <>
          <p className="panel-description">{t('modelManage.hint')}</p>
          {loading && (
            <p role="status">
              <LoaderCircle size={14} className="spin" />
              {t('modelManage.loading')}
            </p>
          )}
          {error && <p role="alert">{t('modelManage.loadError')}</p>}
          <div className="model-manager-total">
            <span>
              {t('modelManage.total', { size: size(present.reduce((sum, m) => sum + m.bytes, 0)) })}
            </span>
            <IconButton
              label={t('refresh')}
              disabled={loading || working}
              onClick={() => setRefresh((n) => n + 1)}
            >
              <RefreshCw size={14} />
            </IconButton>
          </div>
          {!loading && !error && !present.length && <p>{t('modelManage.empty')}</p>}
          <ul aria-label={t('modelManage.list')}>
            {present.map((model) => (
              <li key={model.id}>
                <div>
                  <strong>{model.name}</strong>
                  <small>
                    {size(model.bytes)}
                    {model.error
                      ? ' · ' + t(`errors.${model.error}`, { defaultValue: model.error })
                      : ''}
                  </small>
                </div>
                <IconButton
                  label={t('modelManage.remove', { name: model.name })}
                  disabled={busy || working || loading || !!model.error}
                  onClick={() => {
                    setRemoveError('');
                    setChosen(model);
                  }}
                >
                  <Trash2 size={15} />
                </IconButton>
              </li>
            ))}
          </ul>
          {notice && (
            <p role="status" className="model-manager-notice">
              {notice}
            </p>
          )}
        </>
      )}
      {chosen && (
        <Modal
          title={t('modelManage.confirmTitle')}
          onClose={() => {
            if (!working) setChosen(null);
          }}
        >
          <p>
            <strong>{chosen.name}</strong> · {size(chosen.bytes)}
          </p>
          <p>{t('modelManage.confirm')}</p>
          {removeError && <p role="alert">{removeError}</p>}
          {working && (
            <p role="status">
              <LoaderCircle size={14} className="spin" />
              {t('modelManage.removing')}
            </p>
          )}
          <div className="reference-actions">
            <button className="button subtle" disabled={working} onClick={() => setChosen(null)}>
              {t('cancel')}
            </button>
            <button
              className="button accent"
              disabled={busy || working}
              onClick={() => {
                setWorking(true);
                setRemoveError('');
                void bridge
                  .removeInstalledModel(chosen.id, true)
                  .then(() => {
                    setChosen(null);
                    setRefresh((n) => n + 1);
                    setNotice(t('modelManage.removed'));
                  })
                  .catch((e) => {
                    setRemoveError(
                      t(`errors.${String(e).replace(/^Error: /, '')}`, { defaultValue: String(e) }),
                    );
                    onError(String(e));
                  })
                  .finally(() => setWorking(false));
              }}
            >
              {t('modelManage.confirmButton')}
            </button>
          </div>
        </Modal>
      )}
    </details>
  );
}
