import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Play, RefreshCw, SquareArrowOutUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Dialogue, Generation, Job, Project } from '../domain/types';
import type { VoiceBatchReport, BatchVoiceConversionOptions } from '../domain/voiceCapture';
import { voiceGenerations, selectedGeneration, defaultVoiceSettings } from '../domain/tts';
import { useDubbingTask } from '../hooks/useDubbingTask';
import * as bridge from '../services/bridge';
import { CurrentJobProgress } from './CurrentJobProgress';
import { ReferenceFileImport } from './ReferenceFileImport';
import { IconButton } from './IconButton';

export function BatchVoiceConversion({
  project,
  selectedIds,
  jobs,
  snapshot,
  run,
  onError,
  onModels,
  onPlay,
  onChooseLine,
  queueActive,
}: {
  project: Project;
  selectedIds: string[];
  jobs: Job[];
  snapshot: () => Promise<Project>;
  run: (f: () => Promise<Project | null>) => Promise<void>;
  onError: (e: string) => void;
  onModels: () => void;
  onPlay: (g: Generation) => void;
  onChooseLine: (l: Dialogue) => void;
  queueActive: boolean;
}) {
  const { t } = useTranslation();
  const takes = useMemo(
    () => voiceGenerations(project).filter((g) => g.language === project.languages.target),
    [project],
  );
  const byId = useMemo(() => new Map(takes.map((g) => [g.id, g])), [takes]);
  const grouped = useMemo(() => {
    const m = new Map<string, Generation[]>();
    for (const g of takes) {
      const list = m.get(g.dialogueId) ?? [];
      list.push(g);
      m.set(g.dialogueId, list);
    }
    return m;
  }, [takes]);
  const numbers = useMemo(
    () => new Map(project.dialogues.map((l, i) => [l.id, i + 1])),
    [project.dialogues],
  );
  const lines = useMemo(
    () => project.dialogues.filter((l) => grouped.has(l.id)),
    [project.dialogues, grouped],
  );
  const [kind, setKind] = useState('generation'),
    [referenceLine, setReferenceLine] = useState(
      selectedIds.find((id) => lines.some((l) => l.id === id)) ?? lines[0]?.id ?? '',
    );
  const refLine = lines.find((l) => l.id === referenceLine) ?? lines[0];
  const refTakes = grouped.get(refLine?.id ?? '') ?? [];
  const [refId, setRefId] = useState(''),
    [fileId, setFileId] = useState('');
  const refTake =
    refTakes.find((g) => g.id === refId) ??
    (refLine ? selectedGeneration(project, refLine) : undefined) ??
    refTakes.at(-1);
  const duration = refTake
    ? (project.voiceEdits?.[refTake.id]?.pieces.reduce((s, p) => s + p.durationMs, 0) ??
      refTake.durationMs)
    : 0;
  const [start, setStart] = useState(0),
    [end, setEnd] = useState(20),
    [device, setDevice] = useState('auto');
  const [status, setStatus] = useState<bridge.VoiceStatus | null>(null),
    [pending, setPending] = useState(false),
    [working, setWorking] = useState(false);
  const refs = [
    ...(project.voiceReferences ?? []).map((r) => ({
      ...r,
      owner: null as string | null,
      key: 'file:' + r.id,
    })),
    ...project.characters.flatMap((c) =>
      c.references.map((r) => ({
        ...r,
        label: c.name + ' · ' + r.label,
        owner: c.id,
        key: c.id + ':' + r.id,
      })),
    ),
  ];
  const file = refs.find((r) => r.key === fileId);
  const lastRef = useRef('');
  useEffect(() => {
    if (refTake?.id !== lastRef.current) {
      lastRef.current = refTake?.id ?? '';
      setStart(0);
      setEnd(Math.min(20, duration / 1000));
    }
  }, [refTake?.id, duration]);
  const completion = jobs
    .filter((j) => j.kind === 'ttsInstall' || j.kind === 'modelMove')
    .map((j) => j.id + j.status)
    .join('|');
  useEffect(() => {
    let alive = true;
    void bridge
      .voiceStatus(true)
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch((e) => {
        if (alive) onError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [completion, onError]);
  const task = useDubbingTask(project, undefined, true, jobs, run);
  const busy =
    working ||
    queueActive ||
    task.pending ||
    jobs.some((j) => ['running', 'queued', 'paused'].includes(j.status));
  const rangeValid =
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end * 1000 <= duration &&
    end - start >= 1 &&
    end - start <= 20;
  const valid =
    kind === 'generation'
      ? !!refTake && rangeValid
      : !!file && file.durationMs >= 1000 && file.durationMs <= 20000;
  const options: BatchVoiceConversionOptions = {
    lineIds: selectedIds,
    reference: {
      generationId: 'batch',
      referenceMode: kind === 'generation' ? 'generation' : 'reference',
      referenceId: kind === 'generation' ? (refTake?.id ?? '') : (file?.id ?? ''),
      characterId: kind === 'generation' ? null : (file?.owner ?? null),
      device,
      ...(kind === 'generation'
        ? { referenceRange: { startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) } }
        : {}),
    },
  };
  const key = JSON.stringify(options) + ':' + project.revision;
  const optionsKey = JSON.stringify(options);
  const [plan, setPlan] = useState<{
    key: string;
    ready: string[];
    blocked: { lineId: string; error: string }[];
  } | null>(null);
  useEffect(() => {
    let alive = true;
    if (!valid || !selectedIds.length) return;
    const timer = window.setTimeout(() => {
      void snapshot()
        .then(() => bridge.previewVoiceBatch(JSON.parse(optionsKey)))
        .then((p) => {
          if (alive) setPlan({ key, ...p });
        })
        .catch((e) => {
          if (alive) {
            setPlan(null);
            onError(String(e));
          }
        });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [key, optionsKey, valid, selectedIds.length, snapshot, onError]);
  const preview = plan?.key === key ? plan : null;
  const [url, setUrl] = useState('');
  const audio = useRef<HTMLAudioElement>(null);
  const previewKey = JSON.stringify(
    kind === 'generation' && refTake
      ? { id: refTake.id, edit: project.voiceEdits?.[refTake.id] }
      : file
        ? { owner: file.owner, id: file.id }
        : null,
  );
  useEffect(() => {
    let alive = true;
    setUrl('');
    const selection = JSON.parse(previewKey);
    if (!selection) return;
    const p =
      kind === 'generation'
        ? bridge.generationUrl(selection.id, selection.edit)
        : bridge.voiceReferenceUrl(selection.owner, selection.id);
    void p
      .then((url) => {
        if (alive) setUrl(url);
      })
      .catch((e) => {
        if (alive) onError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [previewKey, kind, onError]);
  const history = jobs.filter(
    (j) => j.projectId === project.id && j.kind === 'voiceConversionBatch',
  );
  const [historyId, setHistoryId] = useState(''),
    [offset, setOffset] = useState(0),
    [checked, setChecked] = useState<string[]>([]);
  const reportId = task.dismissed ? historyId : (task.reportId ?? historyId);
  const job = task.job ?? history.find((j) => j.id === historyId);
  const [report, setReport] = useState<(VoiceBatchReport & { key: string }) | null>(null);
  const reportKey =
    reportId +
    ':' +
    offset +
    ':' +
    project.revision +
    ':' +
    job?.status +
    ':' +
    job?.batch?.completed;
  useEffect(() => {
    let alive = true;
    if (!reportId) return;
    void bridge
      .voiceBatchReport(reportId, offset)
      .then((r) => {
        if (alive) setReport({ ...r, key: reportKey });
      })
      .catch((e) => {
        if (alive) onError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [reportId, offset, reportKey, onError]);
  const rows = report?.key === reportKey ? report.items : [];
  const perform = async (f: () => Promise<string>) => {
    setWorking(true);
    try {
      setOffset(0);
      setChecked([]);
      await task.start(async () => {
        await snapshot();
        return f();
      });
    } catch (e) {
      onError(String(e));
    } finally {
      setWorking(false);
    }
  };
  return (
    <section className="batch-timbre" aria-label={t('batchTimbre.title')}>
      <h3>
        <AudioLines size={16} />
        {t('batchTimbre.title')}
      </h3>
      <p className="panel-description">{t('batchTimbre.hint')}</p>
      <label className="field">
        <span>{t('batchTimbre.referenceKind')}</span>
        <select value={kind} disabled={busy || pending} onChange={(e) => setKind(e.target.value)}>
          <option value="generation">{t('batchTimbre.take')}</option>
          <option value="file">{t('batchTimbre.file')}</option>
        </select>
      </label>
      {kind === 'generation' ? (
        <>
          <label className="field">
            <span>{t('batchTimbre.referenceDialogue')}</span>
            <select
              value={refLine?.id ?? ''}
              disabled={busy}
              onChange={(e) => {
                setReferenceLine(e.target.value);
                setRefId('');
              }}
            >
              {!lines.length && <option value="">{t('ttsNoGeneration')}</option>}
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  #{numbers.get(l.id)} ·{' '}
                  {(l.ttsText || grouped.get(l.id)?.[0]?.text || '').slice(0, 70)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('batchTimbre.referenceTake')}</span>
            <select
              value={refTake?.id ?? ''}
              disabled={busy}
              onChange={(e) => setRefId(e.target.value)}
            >
              {refTakes.map((g, i) => (
                <option key={g.id} value={g.id}>
                  {t('ttsGenerationNumber', { number: i + 1 })} · {g.modelId} ·{' '}
                  {(g.durationMs / 1000).toFixed(2)} s
                </option>
              ))}
            </select>
          </label>
          <div className="character-range">
            <label className="field">
              <span>{t('referenceStart')}</span>
              <input
                type="number"
                min={0}
                step={0.001}
                value={start}
                disabled={busy}
                onChange={(e) => setStart(Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span>{t('referenceEnd')}</span>
              <input
                type="number"
                min={0}
                step={0.001}
                value={end}
                disabled={busy}
                onChange={(e) => setEnd(Number(e.target.value))}
              />
            </label>
          </div>
          {!rangeValid && <p className="warning">{t('batchTimbre.range')}</p>}
        </>
      ) : (
        <>
          <label className="field">
            <span>{t('capture.reference')}</span>
            <select
              value={fileId}
              disabled={busy || pending}
              onChange={(e) => setFileId(e.target.value)}
            >
              <option value="">{t('capture.chooseReference')}</option>
              {refs.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <ReferenceFileImport
            busy={busy}
            onPending={setPending}
            onError={onError}
            onImport={async (f) => {
              let ok = false;
              await run(async () => {
                const p = await bridge.importDubbingReference(null, defaultVoiceSettings, f);
                const r = p?.voiceReferences?.at(-1);
                if (r) {
                  setFileId('file:' + r.id);
                  ok = true;
                }
                return p;
              });
              return ok;
            }}
          />
        </>
      )}
      {url && (
        <audio
          ref={audio}
          controls
          src={url}
          aria-label={t('ttsListenReference')}
          onPlay={() => {
            if (
              kind === 'generation' &&
              audio.current &&
              (audio.current.currentTime < start || audio.current.currentTime >= end)
            )
              audio.current.currentTime = start;
          }}
          onTimeUpdate={() => {
            if (kind === 'generation' && audio.current && audio.current.currentTime >= end)
              audio.current.pause();
          }}
        />
      )}
      <label className="field">
        <span>{t('capture.vcDevice')}</span>
        <select value={device} disabled={busy} onChange={(e) => setDevice(e.target.value)}>
          <option value="auto">{t('auto')}</option>
          <option value="cpu">CPU</option>
          {status?.cudaDevices
            .filter((d) => d.id.startsWith('cuda:'))
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
        </select>
      </label>
      {!status ? (
        <p role="status">{t('batchTimbre.loading')}</p>
      ) : (
        !status.variants.some((v) => v.id === 'chatterbox-vc' && v.installed) && (
          <button className="button subtle wide" onClick={onModels}>
            {t('capture.install')}
          </button>
        )
      )}
      {!selectedIds.length && <p>{t('batchTimbre.select')}</p>}
      {preview && (
        <p role="status">
          {t('batchTimbre.preview', {
            ready: preview.ready.length,
            blocked: preview.blocked.length,
          })}
        </p>
      )}
      {!!preview?.blocked.length && (
        <details>
          <summary>{t('batchExcluded', { count: preview.blocked.length })}</summary>
          {preview.blocked.slice(0, 30).map((b) => (
            <p key={b.lineId}>
              #{project.dialogues.findIndex((l) => l.id === b.lineId) + 1} ·{' '}
              {t('errors.' + b.error, { defaultValue: b.error })}
            </p>
          ))}
        </details>
      )}
      <button
        className="button accent wide"
        disabled={
          busy ||
          pending ||
          !valid ||
          !preview?.ready.length ||
          !status?.variants.some((v) => v.id === 'chatterbox-vc' && v.installed)
        }
        onClick={() => void perform(() => bridge.convertVoiceBatch(JSON.parse(optionsKey)))}
      >
        <AudioLines size={15} />
        {t('batchTimbre.start', { count: preview?.ready.length ?? 0 })}
      </button>
      <CurrentJobProgress
        job={job}
        starting={task.pending}
        error={task.error}
        onError={onError}
        onDismiss={task.canDismiss ? task.dismiss : undefined}
      />
      {!!history.length && (
        <label className="field">
          <span>{t('batchTimbre.history')}</span>
          <select
            value={reportId ?? ''}
            disabled={busy}
            onChange={(e) => {
              task.dismiss();
              setHistoryId(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">{t('batchTimbre.chooseReport')}</option>
            {history.map((j) => (
              <option key={j.id} value={j.id}>
                {j.id.slice(0, 8)} · {t('jobKinds.' + j.kind)} · {j.batch?.completed ?? 0}/
                {j.batch?.total ?? 0} · {j.status}
              </option>
            ))}
          </select>
        </label>
      )}
      {reportId && (
        <>
          <div className="compact-toolbar">
            <button
              className="button subtle"
              disabled={busy}
              onClick={() => void perform(() => bridge.retryVoiceBatch(reportId, checked))}
            >
              <RefreshCw size={14} />
              {t(checked.length ? 'batchTimbre.retrySelected' : 'batchTimbre.retryAll')}
            </button>
            <small>
              {t('batchTimbre.page', {
                from: rows.length ? offset + 1 : 0,
                to: offset + rows.length,
                total: report?.total ?? 0,
              })}
            </small>
          </div>
          {rows.map((row) => {
            const g = byId.get(row.generationId ?? ''),
              source = byId.get(row.sourceId),
              line = project.dialogues.find((l) => l.id === row.lineId);
            return (
              <div className="timbre-result" key={row.lineId}>
                <label>
                  <input
                    type="checkbox"
                    checked={checked.includes(row.lineId)}
                    disabled={busy || row.status === 'succeeded'}
                    onChange={(e) =>
                      setChecked((s) =>
                        e.target.checked ? [...s, row.lineId] : s.filter((id) => id !== row.lineId),
                      )
                    }
                  />{' '}
                  #{project.dialogues.findIndex((l) => l.id === row.lineId) + 1} ·{' '}
                  {t('batchTimbre.status.' + row.status)}
                </label>
                <div className="compact-toolbar">
                  {source && (
                    <IconButton
                      label={t('batchTimbre.listenSource')}
                      onClick={() => onPlay(source)}
                    >
                      <Play size={14} />
                    </IconButton>
                  )}
                  {g && (
                    <IconButton label={t('batchTimbre.listenResult')} onClick={() => onPlay(g)}>
                      <AudioLines size={14} />
                    </IconButton>
                  )}
                  {line && (
                    <IconButton
                      label={t('batchTimbre.openLine')}
                      onClick={() => onChooseLine(line)}
                    >
                      <SquareArrowOutUpRight size={14} />
                    </IconButton>
                  )}
                  {row.status === 'failed' && (
                    <IconButton
                      label={t('batchTimbre.retryOne')}
                      disabled={busy}
                      onClick={() =>
                        void perform(() => bridge.retryVoiceBatch(reportId, [row.lineId]))
                      }
                    >
                      <RefreshCw size={14} />
                    </IconButton>
                  )}
                </div>
                {row.error && (
                  <small className="warning">
                    {t('errors.' + row.error, { defaultValue: row.error })}
                  </small>
                )}
              </div>
            );
          })}
          <div className="compact-toolbar">
            <button
              className="button subtle"
              disabled={!offset}
              onClick={() => {
                setOffset((s) => Math.max(0, s - 25));
                setChecked([]);
              }}
            >
              {t('batchTimbre.previous')}
            </button>
            <button
              className="button subtle"
              disabled={offset + rows.length >= (report?.total ?? 0)}
              onClick={() => {
                setOffset((s) => s + 25);
                setChecked([]);
              }}
            >
              {t('batchTimbre.next')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
