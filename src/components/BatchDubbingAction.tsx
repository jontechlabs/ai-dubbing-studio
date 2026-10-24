import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project, VoiceSettings } from '../domain/types';
import * as bridge from '../services/bridge';

export function BatchDubbingAction({
  project,
  selectedIds,
  settings,
  busy,
  ready,
  snapshot,
  onStarted,
  onError,
}: {
  project: Project;
  selectedIds: string[];
  settings: VoiceSettings;
  busy: boolean;
  ready: boolean;
  snapshot: () => Promise<Project>;
  onStarted: () => void;
  onError: (error: string) => void;
}) {
  const { t } = useTranslation();
  const [scope, setScope] = useState(selectedIds.length ? 'selected' : 'all'),
    [force, setForce] = useState(false),
    [translationFilter, setTranslationFilter] = useState('all'),
    [working, setWorking] = useState(false);
  const [result, setResult] = useState<{
    key: string;
    plan: bridge.DubbingBatchPreview | null;
    error?: string;
  } | null>(null);
  const selectionKey = JSON.stringify({
    scope,
    lineIds: selectedIds,
    force,
    approvedOnly: translationFilter === 'approved',
    unapprovedOnly: translationFilter === 'translated',
    options: settings,
  });
  const key = selectionKey + ':' + project.revision;
  useEffect(() => {
    let disposed = false;
    const timer = setTimeout(() => {
      void snapshot()
        .then(() => bridge.previewDubbingBatch(JSON.parse(selectionKey)))
        .then((plan) => {
          if (!disposed) setResult({ key, plan });
        })
        .catch((error) => {
          if (!disposed) setResult({ key, plan: null, error: String(error) });
        });
    }, 300);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [project, selectionKey, key, snapshot]);
  const plan = result?.key === key ? result.plan : null;
  return (
    <section className="settings-section batch-dubbing">
      <label className="field">
        <span>{t('batchScope')}</span>
        <select value={scope} disabled={busy || working} onChange={(e) => setScope(e.target.value)}>
          <option value="all">{t('batchAllTranslated')}</option>
          <option value="selected">{t('batchSelected', { count: selectedIds.length })}</option>
        </select>
      </label>
      <label className="field">
        <span>{t('batchTranslationFilter')}</span>
        <select
          value={translationFilter}
          disabled={busy || working}
          onChange={(e) => setTranslationFilter(e.target.value)}
        >
          <option value="all">{t('batchTranslationAll')}</option>
          <option value="translated">{t('batchTranslationUnapproved')}</option>
          <option value="approved">{t('batchTranslationApproved')}</option>
        </select>
      </label>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={force}
          disabled={busy || working}
          onChange={(e) => setForce(e.target.checked)}
        />
        {t('batchForce')}
      </label>
      <p className="panel-description">{t('batchPolicyHint')}</p>
      {plan ? (
        <>
          <p role="status">
            {t('batchPreview', {
              ready: plan.ready.length,
              existing: plan.existing,
              untranslated: plan.untranslated,
              unapproved: plan.unapproved,
              approved: plan.approved,
              blocked: plan.blocked.length,
            })}
          </p>
          {!!plan.blocked.length && (
            <details>
              <summary>{t('batchExcluded', { count: plan.blocked.length })}</summary>
              <ul>
                {plan.blocked.slice(0, 30).map((p) => (
                  <li key={p.lineId}>
                    {t('batchLine', {
                      number: project.dialogues.findIndex((l) => l.id === p.lineId) + 1,
                    })}{' '}
                    : {t(`errors.${p.error}`, { defaultValue: p.error })}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      ) : (
        <p role="status">
          {result?.key === key && result.error
            ? t(`errors.${result.error}`, { defaultValue: result.error })
            : t('batchChecking')}
        </p>
      )}
      <button
        className="button accent wide"
        disabled={!bridge.native || busy || working || !ready || !plan?.ready.length}
        onClick={() => {
          setWorking(true);
          void snapshot()
            .then(() => bridge.generateDubbingBatch(JSON.parse(selectionKey)))
            .then(onStarted)
            .catch((e) => onError(String(e)))
            .finally(() => setWorking(false));
        }}
      >
        {t('batchStart', { count: plan?.ready.length ?? 0 })}
      </button>
    </section>
  );
}
