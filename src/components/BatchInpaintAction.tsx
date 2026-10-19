import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Job, Project } from '../domain/types';
import type { InpaintOptions } from '../domain/inpaint';
import * as bridge from '../services/bridge';
import { FaceDetectionAction } from './FaceDetectionAction';

export function BatchInpaintAction({
  project,
  selectedIds,
  options,
  crops,
  jobs,
  onDetectedCrops,
  busy,
  ready,
  commonReady,
  snapshot,
  onStarted,
  onError,
}: {
  project: Project;
  selectedIds: string[];
  options: InpaintOptions;
  crops: bridge.InpaintBatchSelection['crops'];
  jobs: Job[];
  onDetectedCrops: (crops: bridge.InpaintBatchSelection['crops']) => void;
  busy: boolean;
  ready: boolean;
  commonReady: boolean;
  snapshot: () => Promise<Project>;
  onStarted: () => void;
  onError: (error: string) => void;
}) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<'all' | 'selected'>(selectedIds.length ? 'selected' : 'all');
  const [force, setForce] = useState(false),
    [useSavedCrops, setSaved] = useState(true),
    [useCommonCrop, setCommon] = useState(false),
    [activate, setActivate] = useState(false),
    [working, setWorking] = useState(false);
  const selectionKey = JSON.stringify({
    scope,
    lineIds: selectedIds,
    force,
    useSavedCrops,
    useCommonCrop,
    activate,
    crops,
    options,
  });
  const key = selectionKey + ':' + project.revision;
  const [result, setResult] = useState<{
    key: string;
    plan?: bridge.InpaintBatchPreview;
    error?: string;
  } | null>(null);
  useEffect(() => {
    let disposed = false;
    const timer = setTimeout(() => {
      void snapshot()
        .then(() => bridge.previewInpaintBatch(JSON.parse(selectionKey)))
        .then((plan) => {
          if (!disposed) setResult({ key, plan });
        })
        .catch((error) => {
          if (!disposed) setResult({ key, error: String(error) });
        });
    }, 250);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [key, selectionKey, snapshot]);
  const plan = result?.key === key ? result.plan : undefined;
  const locked = busy || working;
  return (
    <section className="settings-section batch-inpaint">
      <h3>{t('inpaintBatch')}</h3>
      <label className="field">
        <span>{t('inpaintBatchScope')}</span>
        <select
          aria-label={t('inpaintBatchScope')}
          value={scope}
          disabled={locked}
          onChange={(e) => setScope(e.target.value as 'all' | 'selected')}
        >
          <option value="all">{t('inpaintBatchAll')}</option>
          <option value="selected">
            {t('inpaintBatchSelected', { count: selectedIds.length })}
          </option>
        </select>
      </label>
      <FaceDetectionAction
        project={project}
        jobs={jobs}
        selection={JSON.parse(selectionKey)}
        busy={locked}
        ready={ready}
        snapshot={snapshot}
        onApply={onDetectedCrops}
        onError={onError}
      />
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={useSavedCrops}
          disabled={locked}
          onChange={(e) => setSaved(e.target.checked)}
        />
        {t('inpaintBatchSavedCrops')}
      </label>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={useCommonCrop}
          disabled={locked || !commonReady}
          onChange={(e) => setCommon(e.target.checked)}
        />
        {t('inpaintBatchCommonCrop')}
      </label>
      <p className="warning">{t('inpaintBatchCropWarning')}</p>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={force}
          disabled={locked}
          onChange={(e) => setForce(e.target.checked)}
        />
        {t('inpaintBatchForce')}
      </label>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={activate}
          disabled={locked}
          onChange={(e) => setActivate(e.target.checked)}
        />
        {t('inpaintBatchActivate')}
      </label>
      <p className="panel-description">{t('inpaintBatchSourceKept')}</p>
      {plan ? (
        <>
          <p role="status">
            {t('inpaintBatchPlan', {
              ready: plan.ready.length,
              requested: plan.requested,
              undubbed: plan.undubbed,
              existing: plan.existing,
              crops: plan.missingCrop,
              blocked: plan.blocked.length,
            })}
          </p>
          {plan.blocked.length > 0 && (
            <details>
              <summary>{t('inpaintBatchProblems')}</summary>
              {plan.blocked.map((row) => (
                <p key={row.lineId}>
                  {project.dialogues.findIndex((l) => l.id === row.lineId) + 1} ·{' '}
                  {t('errors.' + row.error)}
                </p>
              ))}
            </details>
          )}
        </>
      ) : (
        <p role="status">
          {result?.key === key && result.error
            ? t('errors.' + result.error.replace(/^Error: /, ''))
            : t('loading')}
        </p>
      )}
      <button
        className="button accent wide"
        disabled={locked || !ready || !plan?.ready.length || (useCommonCrop && !commonReady)}
        onClick={async () => {
          setWorking(true);
          try {
            await snapshot();
            await bridge.startInpaintBatch(JSON.parse(selectionKey));
            onStarted();
          } catch (e) {
            onError(String(e));
          } finally {
            setWorking(false);
          }
        }}
      >
        {t('inpaintBatchStart', { count: plan?.ready.length ?? 0 })}
      </button>
    </section>
  );
}
