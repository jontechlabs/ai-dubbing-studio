import { useEffect, useState } from 'react';
import { Languages, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Dialogue, Job, Project } from '../domain/types';
import {
  applyTranslationProposal,
  proposalCurrent,
  type TranslationProposal,
} from '../domain/translationProposal';
import { dialogueText } from '../domain/subtitles';
import * as bridge from '../services/bridge';

export function TranslationSuggestion({
  project,
  line,
  jobs,
  snapshot,
  onEdit,
  busy,
}: {
  project: Project;
  line: Dialogue;
  jobs: Job[];
  snapshot: () => Promise<Project>;
  onEdit: (update: (p: Project) => Project) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false),
    [status, setStatus] = useState<bridge.TranslationStatus | null>(null);
  const [device, setDevice] = useState(localStorage.getItem('studio.translationDevice') ?? '');
  const [key, setKey] = useState<string | null>(null),
    [working, setWorking] = useState(false);
  const [proposal, setProposal] = useState<TranslationProposal | null>(null);
  const [error, setError] = useState<string | null>(null),
    [applied, setApplied] = useState(false);
  const job = jobs.find((j) => j.id === key);
  const active = !!job && ['queued', 'running', 'paused'].includes(job.status);
  const otherActive = jobs.some((j) => ['queued', 'running', 'paused'].includes(j.status));
  const installRevision = jobs
    .filter((j) => j.kind === 'translationInstall')
    .map((j) => `${j.id}:${j.status}`)
    .join();
  useEffect(() => {
    if (!open || !bridge.native) return;
    let disposed = false;
    void bridge
      .translationStatus()
      .then((value) => {
        if (disposed) return;
        setStatus((previous) =>
          value.installed && !value.devices.length && previous?.devices.length
            ? { ...value, devices: previous.devices }
            : value,
        );
        if (!value.devices.length) return;
        setDevice((previous) =>
          value.devices.some((d) => d.id === previous)
            ? previous
            : (
                value.devices.find((d) => /nvidia/i.test(d.name)) ??
                value.devices.find((d) => d.id !== 'cpu') ?? { id: 'cpu' }
              ).id,
        );
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [open, installRevision, otherActive]);
  useEffect(() => {
    if (!open || !bridge.native) return;
    let disposed = false;
    void bridge
      .latestTranslation(line.id)
      .then((id) => {
        if (!disposed && id) setKey(id);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [open, line.id]);
  useEffect(() => {
    if (!key || job?.status === 'running' || job?.status === 'queued') return;
    let disposed = false;
    if (job?.kind !== 'translationInstall')
      void bridge
        .translationResult(key)
        .then((result) => {
          if (!disposed && result) {
            setProposal(result);
            setApplied(false);
          }
        })
        .catch((e) => {
          if (!disposed) setError(String(e));
        });
    return () => {
      disposed = true;
    };
  }, [key, job?.status, job?.kind]);
  const message = error ?? job?.error;
  const current = proposal && proposalCurrent(project, proposal);
  const run = (operation: () => Promise<string>) => {
    setWorking(true);
    setError(null);
    setProposal(null);
    setApplied(false);
    void operation()
      .then(setKey)
      .catch((e) => setError(String(e)))
      .finally(() => setWorking(false));
  };
  return (
    <div className="translation-suggestion">
      <button
        className="button subtle"
        disabled={!bridge.native || busy}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Languages size={14} />
        {t('llmOpen')}
      </button>
      {open && (
        <div className="translation-suggestion-body">
          <strong>{status?.modelName ?? 'Qwen3-4B-Instruct-2507 · GGUF Q4_K_M'}</strong>
          <p className="panel-description">{t('llmHint')}</p>
          {!status ? (
            <p role="status">{t('llmChecking')}</p>
          ) : !status.installed ? (
            <>
              <p className="panel-description">{t('llmInstallHint')}</p>
              <p className="panel-description model-storage-path">{status.path}</p>
              <p>
                {t('llmDisk', {
                  required: (status.requiredBytes / 1024 ** 3).toFixed(2),
                  available:
                    status.availableBytes === null
                      ? '—'
                      : (status.availableBytes / 1024 ** 3).toFixed(2),
                })}
              </p>
              <button
                className="button accent"
                disabled={otherActive || working || !status.enough || busy}
                onClick={() => run(bridge.installTranslationModel)}
              >
                {t('llmInstall')}
              </button>
              {!status.enough && <p role="alert">{t('errors.TRANSLATION_DISK_REQUIRED')}</p>}
            </>
          ) : (
            <>
              <label className="field">
                <span>{t('llmDevice')}</span>
                <select
                  aria-label={t('llmDevice')}
                  value={device}
                  disabled={working || otherActive || busy}
                  onChange={(e) => {
                    setDevice(e.target.value);
                    localStorage.setItem('studio.translationDevice', e.target.value);
                  }}
                >
                  {!status.devices.length && <option value="cpu">CPU</option>}
                  {status.devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              {status.warning && <p role="alert">{t(`errors.${status.warning}`)}</p>}
              <button
                className="button accent"
                disabled={
                  busy || otherActive || working || !dialogueText(project, line, 'source').trim()
                }
                onClick={() =>
                  run(async () => {
                    await snapshot();
                    return bridge.suggestTranslation(line.id, device || 'cpu');
                  })
                }
              >
                <Languages size={14} />
                {t('llmSuggest')}
              </button>
            </>
          )}
          {(active || working) && (
            <p role="status" className="translation-working">
              <LoaderCircle size={14} className="spin" />
              {t(job ? `jobStages.${job.stage}` : 'llmChecking', {
                defaultValue: t('llmChecking'),
              })}
              {active && (
                <button
                  className="text-button"
                  onClick={() => {
                    void bridge.cancelJob(key!).catch((e) => setError(String(e)));
                  }}
                >
                  {t('cancel')}
                </button>
              )}
            </p>
          )}
          {job?.status === 'cancelled' && <p role="status">{t('jobCancelled')}</p>}
          {message && (
            <p className="warning" role="alert">
              {t(
                `errors.${message
                  .replace(/^Error:\s*/, '')
                  .split(':')[0]
                  .trim()}`,
                { defaultValue: message },
              )}
            </p>
          )}
          {proposal && !applied && (
            <div className="translation-proposal">
              <strong>{t('llmProposal')}</strong>
              {proposal.translations.map((text, i) => (
                <label className="field" key={i}>
                  <span>{t('llmSlot', { number: i + 1 })}</span>
                  <textarea
                    aria-label={t('llmSlot', { number: i + 1 })}
                    value={text}
                    disabled={busy}
                    onChange={(e) =>
                      setProposal({
                        ...proposal,
                        translations: proposal.translations.map((old, n) =>
                          n === i ? e.target.value : old,
                        ),
                      })
                    }
                  />
                </label>
              ))}
              {!current && (
                <p className="warning" role="alert">
                  {t('errors.TRANSLATION_STALE')}
                </p>
              )}
              <p className="panel-description">{t('llmApplyHint')}</p>
              <button
                className="button accent"
                disabled={busy || !current || proposal.translations.some((text) => !text.trim())}
                onClick={() => {
                  onEdit((p) => applyTranslationProposal(p, proposal));
                  setApplied(true);
                }}
              >
                {t('llmApply')}
              </button>
              <button className="text-button" onClick={() => setProposal(null)}>
                {t('llmDiscard')}
              </button>
            </div>
          )}
          {applied && <p role="status">{t('llmApplied')}</p>}
        </div>
      )}
    </div>
  );
}
