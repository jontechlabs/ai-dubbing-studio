import { useModelRevision } from '../hooks/useModelRevision';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AudioSelection, Job, Project } from '../domain/types';
import type {
  AudioToolboxStatus,
  AudioToolboxResult,
  AudioToolboxDestination,
} from '../domain/audioToolbox';
import { audioTracks, trackLabel } from '../domain/audio';
import { formatTime } from '../domain/time';
import * as bridge from '../services/bridge';
import { CurrentJobProgress } from './CurrentJobProgress';
export function AudioToolboxPanel({
  project,
  selection,
  initialModel,
  jobs,
  busy,
  run,
  snapshot,
  onError,
  onAudition,
}: {
  project: Project;
  selection: AudioSelection | null;
  initialModel?: string | null;
  jobs: Job[];
  busy: boolean;
  run: (operation: () => Promise<Project | null>) => Promise<void>;
  snapshot: () => Promise<Project>;
  onError: (error: string) => void;
  onAudition: () => void;
}) {
  const { t } = useTranslation(),
    [open, setOpen] = useState(!!initialModel),
    [status, setStatus] = useState<AudioToolboxStatus | null>(null),
    [speakers, setSpeakers] = useState<AudioToolboxStatus | null>(null),
    [loading, setLoading] = useState(false),
    [loadError, setLoadError] = useState(''),
    [reload, setReload] = useState(0),
    [modelId, setModelId] = useState(initialModel ?? 'mel-band-roformer-kim');
  const [source, setSource] = useState(selection?.trackId ?? 'original'),
    [start, setStart] = useState(selection?.startMs ?? 0),
    [end, setEnd] = useState(selection?.endMs ?? 0),
    [device, setDevice] = useState('auto'),
    [prompt, setPrompt] = useState(''),
    [windowSeconds, setWindow] = useState(4);
  const [request, setRequest] = useState<{ id: string; scope: string } | null>(null),
    [storedResult, setResult] = useState<AudioToolboxResult | null>(null),
    [urls, setUrls] = useState<Record<string, string>>({}),
    [mappings, setMappings] = useState<Record<string, string>>({}),
    [muteSource, setMuteSource] = useState(false),
    [working, setWorking] = useState(false),
    [routing, setRouting] = useState<'replace' | 'add'>('add');
  const modelRevision = useModelRevision();
  const scope = JSON.stringify([
    project.id,
    project.media?.id,
    project.media?.path,
    selection?.mediaId,
    selection?.trackId,
    selection?.startMs,
    selection?.endMs,
    source,
    start,
    end,
    modelId,
    device,
    prompt,
    windowSeconds,
  ]);
  const currentScope = useRef(scope);
  const key = request?.scope === scope ? request.id : null;
  const result = key ? storedResult : null;
  const speakerModel = !!speakers?.models.some((m) => m.id === modelId);
  useLayoutEffect(() => {
    currentScope.current = scope;
    setRequest(null);
    setResult(null);
    setUrls({});
    setMappings({});
    setMuteSource(false);
    return () => {
      currentScope.current = '';
    };
  }, [scope]);
  const launch = async (operation: () => Promise<string>) => {
    const owner = scope;
    const id = await operation();
    if (currentScope.current === owner) setRequest({ id, scope: owner });
  };
  const section = useRef<HTMLDetailsElement | null>(null),
    job = jobs.find((j) => j.id === key),
    completed = jobs
      .filter(
        (j) =>
          ['toolboxInstall', 'speakerSeparationInstall'].includes(j.kind) &&
          ['succeeded', 'failed', 'cancelled'].includes(j.status),
      )
      .map((j) => j.id + j.status)
      .join('|');
  useEffect(() => {
    if (initialModel) {
      setOpen(true);
      setModelId(initialModel);
      requestAnimationFrame(() => section.current?.scrollIntoView({ block: 'start' }));
    }
  }, [initialModel]);
  useEffect(() => {
    if (selection?.mediaId === project.media?.id) {
      setSource(selection!.trackId);
      setStart(selection!.startMs);
      setEnd(selection!.endMs);
    }
  }, [selection, project.media?.id]);
  useEffect(() => {
    let disposed = false;
    if (open && bridge.native) {
      setLoading(true);
      setLoadError('');
      void Promise.all([bridge.audioToolboxStatus(), bridge.speakerSeparationStatus()])
        .then(([base, multi]) => {
          if (!disposed) {
            setStatus(base);
            setSpeakers(multi);
          }
        })
        .catch((e) => {
          if (!disposed) setLoadError(String(e));
        })
        .finally(() => {
          if (!disposed) setLoading(false);
        });
    }
    return () => {
      disposed = true;
    };
  }, [open, completed, reload, modelRevision]);
  useEffect(() => {
    let disposed = false;
    if (
      key &&
      job?.status === 'succeeded' &&
      ['audioToolbox', 'speakerSeparation'].includes(job.kind)
    )
      void (
        job.kind === 'speakerSeparation'
          ? bridge.speakerSeparationResult(key)
          : bridge.audioToolboxResult(key)
      )
        .then((v) => {
          if (!disposed) setResult(v);
        })
        .catch((e) => {
          if (!disposed) onError(String(e));
        });
    return () => {
      disposed = true;
    };
  }, [key, job?.status, job?.kind, project.revision, onError]);
  useEffect(() => {
    let disposed = false;
    if (result)
      void Promise.all(
        result.outputs.map(
          async (role) =>
            [
              role,
              await (speakerModel ? bridge.speakerSeparationUrl : bridge.audioToolboxUrl)(
                result.id,
                role,
              ),
            ] as const,
        ),
      )
        .then((rows) => {
          if (!disposed) setUrls(Object.fromEntries(rows));
        })
        .catch((e) => {
          if (!disposed) onError(String(e));
        });
    return () => {
      disposed = true;
    };
  }, [result, speakerModel, onError]);
  const catalog = [...(status?.models ?? []), ...(speakers?.models ?? [])];
  const inventory = speakerModel ? speakers : status;
  const model = catalog.find((m) => m.id === modelId),
    locked = busy || working || loading || !!loadError,
    range = end - start,
    canRun =
      !!project.media &&
      !!model?.installed &&
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start >= 0 &&
      range >= 100 &&
      range <= 60000 &&
      end <= project.media.durationMs &&
      (model.family !== 'audiosep' || !!prompt.trim());
  const bytes = (n: number) => `${(n / 1024 ** 3).toFixed(2)} Gio`,
    tracks = audioTracks(project).filter((t) => t.kind !== 'dubbing');
  const chosen = Object.values(mappings).filter(Boolean),
    duplicateDestination = new Set(chosen).size !== chosen.length && !speakerModel;
  const outputName = (role: string) =>
    speakerModel
      ? t('overlap.voice', { number: (result?.outputs.indexOf(role) ?? 0) + 1 })
      : t(`toolbox.outputs.${role}`, { defaultValue: role });
  const perform = (operation: () => Promise<unknown>) => {
    setWorking(true);
    void operation()
      .catch((e) => onError(String(e)))
      .finally(() => setWorking(false));
  };
  return (
    <details
      className="audio-toolbox"
      ref={section}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>{t('toolbox.title')}</summary>
      {open && (
        <>
          <p>{t('toolbox.hint')}</p>
          {loading && (
            <div className="toolbox-loading" role="status">
              <LoaderCircle size={15} className="spin" />
              <span>{t('compact.loadingModels')}</span>
              <progress aria-label={t('compact.loadingModels')} />
            </div>
          )}
          {loadError && (
            <div className="toolbox-load-error" role="alert">
              <p>{t('compact.modelsFailed')}</p>
              <button className="button subtle" onClick={() => setReload((n) => n + 1)}>
                <RefreshCw size={14} />
                {t('retry')}
              </button>
            </div>
          )}

          <label className="field">
            <span>{t('toolbox.model')}</span>
            <select
              aria-label={t('toolbox.model')}
              value={modelId}
              disabled={locked}
              onChange={(e) => setModelId(e.target.value)}
            >
              {loading && <option value={modelId}>{t('compact.loadingModels')}</option>}
              {!loading &&
                catalog.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            <span>{t('toolbox.source')}</span>
            <select
              aria-label={t('toolbox.source')}
              value={source}
              disabled={locked}
              onChange={(e) => setSource(e.target.value)}
            >
              {tracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {t(trackLabel(track))}
                </option>
              ))}
            </select>
          </label>
          <div className="toolbox-range">
            {(['start', 'end'] as const).map((side) => (
              <label className="field" key={side}>
                <span>{t(side === 'start' ? 'toolbox.start' : 'toolbox.end')}</span>
                <input
                  aria-label={t(side === 'start' ? 'toolbox.start' : 'toolbox.end')}
                  type="number"
                  min={0}
                  max={project.media?.durationMs ? project.media.durationMs / 1000 : 0}
                  step={0.001}
                  value={(side === 'start' ? start : end) / 1000}
                  disabled={locked}
                  onChange={(e) =>
                    (side === 'start' ? setStart : setEnd)(
                      Math.round(Number(e.target.value) * 1000),
                    )
                  }
                />
              </label>
            ))}
          </div>
          <small>
            {formatTime(start)} → {formatTime(end)} · {t('toolbox.rangeHint')}
          </small>
          {model?.family === 'audiosep' && (
            <label className="field">
              <span>{t('toolbox.prompt')}</span>
              <textarea
                aria-label={t('toolbox.prompt')}
                value={prompt}
                maxLength={500}
                disabled={locked}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="A man speaking · footsteps · background music"
              />
              <small>{t('toolbox.promptHint')}</small>
            </label>
          )}
          <label className="field">
            <span>{t('ttsDevice')}</span>
            <select
              aria-label={t('toolbox.device')}
              value={device}
              disabled={locked}
              onChange={(e) => setDevice(e.target.value)}
            >
              <option value="auto">{t('auto')}</option>
              {inventory?.devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('toolbox.window')}</span>
            <select
              aria-label={t('toolbox.window')}
              value={windowSeconds}
              disabled={locked}
              onChange={(e) => setWindow(Number(e.target.value))}
            >
              {[2, 4, 6, 8].map((n) => (
                <option key={n} value={n}>
                  {n} s
                </option>
              ))}
            </select>
          </label>
          <small>{t('toolbox.memoryHint')}</small>
          {model && (
            <>
              <p className="panel-description">
                {model.license} · {bytes(model.modelBytes)} {t('toolbox.weights')}
              </p>
              <p>
                {t('toolbox.disk', {
                  required: bytes(model.requiredBytes),
                  available:
                    inventory?.availableBytes == null ? '?' : bytes(inventory.availableBytes),
                })}
              </p>
              {
                <button
                  className="button subtle wide"
                  disabled={
                    locked ||
                    (inventory?.availableBytes != null &&
                      inventory.availableBytes < model.requiredBytes)
                  }
                  onClick={() =>
                    perform(async () => {
                      setResult(null);
                      await launch(() =>
                        speakerModel
                          ? bridge.installSpeakerSeparationModel(model.id)
                          : bridge.installAudioToolboxModel(model.id),
                      );
                    })
                  }
                >
                  {t(model.installed ? 'toolbox.verify' : 'toolbox.install')}
                </button>
              }
            </>
          )}
          {model?.family === 'demucs' && <p className="warning">{t('toolbox.demucsHint')}</p>}
          <button
            className="button accent wide"
            disabled={locked || !canRun}
            onClick={() =>
              perform(async () => {
                await snapshot();
                setResult(null);
                setMappings({});
                setUrls({});
                await launch(() =>
                  (speakerModel ? bridge.separateDialogueSpeakers : bridge.separateAudioSelection)({
                    modelId,
                    sourceTrackId: source,
                    startMs: start,
                    endMs: end,
                    device,
                    prompt,
                    windowSeconds,
                  }),
                );
              })
            }
          >
            {t('toolbox.separate')}
          </button>
          <CurrentJobProgress job={job} onError={onError} />
          {result && (
            <section className="toolbox-results">
              <strong>{t('toolbox.preview')}</strong>
              <p>
                {result.deviceName} · {formatTime(result.options.startMs)} →{' '}
                {formatTime(result.options.endMs)}
              </p>
              {result.outputs.map((role) => (
                <div className="toolbox-output" key={role}>
                  {speakerModel ? (
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        aria-label={t('compact.keepVoice', { name: outputName(role) })}
                        checked={!!mappings[role]}
                        disabled={locked || result.applied || result.stale}
                        onChange={(e) =>
                          setMappings({
                            ...mappings,
                            [role]: e.target.checked ? 'role:speech' : '',
                          })
                        }
                      />
                      {t('overlap.voice', { number: result.outputs.indexOf(role) + 1 })}
                    </label>
                  ) : (
                    <label>{t(`toolbox.outputs.${role}`, { defaultValue: role })}</label>
                  )}
                  <audio
                    controls
                    preload="metadata"
                    src={urls[role]}
                    onPlay={(e) => {
                      document.querySelectorAll('audio').forEach((a) => {
                        if (a !== e.currentTarget) a.pause();
                      });
                      onAudition();
                    }}
                    aria-label={t('toolbox.listen', {
                      name: outputName(role),
                    })}
                  />
                  <select
                    aria-label={t('toolbox.destination', {
                      name: outputName(role),
                    })}
                    value={mappings[role] ?? ''}
                    disabled={
                      locked || result.applied || result.stale || (speakerModel && !mappings[role])
                    }
                    onChange={(e) => setMappings({ ...mappings, [role]: e.target.value })}
                  >
                    <option value="">{t('toolbox.skip')}</option>
                    {['speech', 'music', 'sfx'].map((r) => (
                      <option key={r} value={'role:' + r}>
                        {t(`stem.${r}`)}
                      </option>
                    ))}
                    {tracks
                      .filter((t) => t.kind === 'audio' && !t.role)
                      .map((track) => (
                        <option key={track.id} value={'track:' + track.id}>
                          {t(trackLabel(track))}
                        </option>
                      ))}
                  </select>
                </div>
              ))}
              {speakerModel && (
                <label className="field">
                  <span>{t('overlap.routing')}</span>
                  <select
                    aria-label={t('overlap.routing')}
                    value={routing}
                    disabled={locked || result.applied || result.stale}
                    onChange={(e) => setRouting(e.target.value as 'replace' | 'add')}
                  >
                    <option value="add">{t('overlap.add')}</option>
                    <option value="replace">{t('overlap.replace')}</option>
                  </select>
                  <small>{t('compact.multiVoiceHint')}</small>
                </label>
              )}
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={muteSource}
                  disabled={locked || result.applied || result.stale}
                  onChange={(e) => setMuteSource(e.target.checked)}
                />
                {t('toolbox.muteSource')}
              </label>
              <small>{t('toolbox.applyHint')}</small>
              {duplicateDestination && <p className="warning">{t('toolbox.uniqueDestination')}</p>}
              {result.stale && !result.applied && <p className="warning">{t('toolbox.stale')}</p>}
              {result.applied && <p role="status">{t('toolbox.applied')}</p>}
              <button
                className="button accent wide"
                disabled={
                  locked || result.applied || result.stale || !chosen.length || duplicateDestination
                }
                onClick={() =>
                  perform(() =>
                    run(async () => {
                      const destinations: AudioToolboxDestination[] = Object.entries(mappings)
                        .filter(([, v]) => v)
                        .map(([outputId, v]) => ({
                          outputId,
                          trackId: v.startsWith('track:') ? v.slice(6) : null,
                          role: v.startsWith('role:') ? v.slice(5) : null,
                        }));
                      return speakerModel
                        ? bridge.applySpeakerSeparationResult(
                            result.id,
                            destinations.map((d) => ({
                              ...d,
                              role: d.role as 'speech' | 'music' | 'sfx' | null,
                              mode: routing,
                            })),
                            muteSource,
                          )
                        : bridge.applyAudioToolboxResult(result.id, destinations, muteSource);
                    }),
                  )
                }
              >
                {t('toolbox.apply')}
              </button>
            </section>
          )}
        </>
      )}
    </details>
  );
}
