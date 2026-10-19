import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, LoaderCircle, Play, Pause, ScanFace } from 'lucide-react';
import type { Dialogue, Job, Project } from '../domain/types';
import { BatchInpaintAction } from './BatchInpaintAction';
import type { InpaintOptions } from '../domain/inpaint';
import type { MouthRegion } from '../domain/lips';
import {
  currentLipVideo,
  lipVideos,
  selectLipVideo,
  INPAINT_MODELS,
  inpaintModelLabel,
  inpaintLimit,
  type InpaintModelId,
} from '../domain/inpaint';
import { dubbingClips } from '../domain/mix';
import { formatTime } from '../domain/time';
import * as bridge from '../services/bridge';

function useRuntime(jobs: Job[], onError: (e: string) => void) {
  const [modelId, setModel] = useState<InpaintModelId>(() => {
    const value = localStorage.getItem('studio.inpaintModel') as InpaintModelId;
    return INPAINT_MODELS.includes(value) ? value : 'musetalk-15-fp16';
  });
  const [refreshCount, refresh] = useState(0);
  const chooseModel = (value: InpaintModelId) => {
    localStorage.setItem('studio.inpaintModel', value);
    setModel(value);
  };
  const [status, setStatus] = useState<bridge.InpaintStatus | null>(null),
    [working, setWorking] = useState(false);
  const completion = jobs
    .filter(
      (j) =>
        ['inpaintInstall', 'inpaint', 'modelMove'].includes(j.kind) &&
        ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.status),
    )
    .map((j) => j.id + j.status)
    .join('|');
  useEffect(() => {
    let disposed = false;
    setStatus(null);
    if (bridge.native)
      void bridge
        .inpaintStatus(modelId)
        .then((value) => {
          if (!disposed) setStatus(value);
        })
        .catch((e) => {
          if (!disposed) onError(String(e));
        });
    return () => {
      disposed = true;
    };
  }, [completion, onError, modelId, refreshCount]);
  const busy = jobs.some((j) => ['queued', 'running', 'paused'].includes(j.status));
  const install = async () => {
    setWorking(true);
    try {
      await bridge.installInpaint(modelId);
    } catch (e) {
      onError(String(e));
    } finally {
      setWorking(false);
    }
  };
  return {
    status,
    working,
    busy,
    install,
    modelId,
    chooseModel,
    refresh: () => refresh((v) => v + 1),
  };
}
function ModelCard({ runtime }: { runtime: ReturnType<typeof useRuntime> }) {
  const { t } = useTranslation(),
    { status, working, busy, install } = runtime;
  return (
    <div className="model-card">
      <label className="field">
        <span>{t('inpaintEngine')}</span>
        <select
          aria-label={t('inpaintEngine')}
          value={runtime.modelId}
          disabled={working || busy}
          onChange={(e) => runtime.chooseModel(e.target.value as InpaintModelId)}
        >
          {INPAINT_MODELS.map((id) => (
            <option key={id} value={id}>
              {inpaintModelLabel(id)}
            </option>
          ))}
        </select>
      </label>
      <h3>
        <ScanFace size={16} /> {inpaintModelLabel(runtime.modelId)}
      </h3>
      <span className="model-state">
        {t(status?.installed ? 'modelInstalled' : 'modelNotInstalled')}
      </span>
      <p>
        {t(
          runtime.modelId === 'musetalk-15-fp16'
            ? 'inpaintModelHint'
            : runtime.modelId === 'latentsync-15'
              ? 'latent15Hint'
              : 'latent16Hint',
        )}
      </p>
      <small>
        {status ? `${(status.sizeBytes / 1024 ** 3).toFixed(2)} GiB` : t('loading')} ·{' '}
        {t(runtime.modelId === 'musetalk-15-fp16' ? 'inpaintRuntimeSize' : 'latentRuntimeSize')}
      </small>
      {status?.space && (
        <p className={status.space.enough ? 'panel-description' : 'warning'}>
          {t('inpaintDiskSpace', {
            available: (status.space.availableBytes / 1024 ** 3).toFixed(2),
            required: (status.space.requiredBytes / 1024 ** 3).toFixed(2),
          })}
        </p>
      )}
      <button className="text-button" disabled={working || busy} onClick={runtime.refresh}>
        {t('inpaintRefresh')}
      </button>
      <button
        className="button accent wide"
        disabled={!bridge.native || working || busy || !status || status.space?.enough === false}
        onClick={() => void install()}
      >
        {working ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}{' '}
        {t(
          runtime.modelId === 'musetalk-15-fp16'
            ? status?.installed
              ? 'inpaintRepair'
              : 'inpaintInstall'
            : status?.installed
              ? 'latentRepair'
              : 'latentInstall',
        )}
      </button>
    </div>
  );
}
export function InpaintModel({ jobs, onError }: { jobs: Job[]; onError: (e: string) => void }) {
  return <ModelCard runtime={useRuntime(jobs, onError)} />;
}

export function InpaintPanel({
  project,
  line: initialLine,
  batch,
  onStarted,
  jobs,
  snapshot,
  onEdit,
  onError,
}: {
  project: Project;
  line: Dialogue | undefined;
  batch?: { selectedIds: string[] };
  onStarted?: () => void;
  jobs: Job[];
  snapshot: () => Promise<Project>;
  onEdit: (update: (p: Project) => Project) => void;
  onError: (e: string) => void;
}) {
  const { t } = useTranslation(),
    runtime = useRuntime(jobs, onError);
  const [inferenceSteps, setInferenceSteps] = useState(20),
    [guidanceScale, setGuidanceScale] = useState(1.5);
  const clips = useMemo(() => dubbingClips(project), [project]);
  const [frameLineId, setFrameLineId] = useState(initialLine?.id ?? clips[0]?.line.id ?? '');
  const [crops, setCrops] = useState<bridge.InpaintBatchSelection['crops']>({});
  const [detected, setDetected] = useState<{
    revision: number;
    sourcePath: string;
    values: bridge.InpaintBatchSelection['crops'];
  } | null>(null);
  const detectedCrops =
    detected?.revision === project.revision && detected.sourcePath === project.media?.path
      ? detected.values
      : {};
  const preparedCrops = { ...detectedCrops, ...crops };
  const line = batch
    ? (clips.find((c) => c.line.id === frameLineId) ?? clips[0])?.line
    : initialLine;
  const clip = clips.find((c) => c.line.id === line?.id);
  const edits = lipVideos(project).filter((e) => e.dialogueId === line?.id),
    [chosen, setChosen] = useState<string | null>(null),
    [mode, setMode] = useState<'original' | 'retouched'>('original');
  const edit = edits.find((e) => e.id === chosen) ?? edits.at(-1);
  const video = useRef<HTMLVideoElement>(null),
    audio = useRef<HTMLAudioElement>(null),
    stage = useRef<HTMLDivElement>(null),
    drag = useRef<{ x: number; y: number } | null>(null);
  const [source, setSource] = useState<string | null>(null),
    [ready, setReady] = useState(false),
    [retouched, setRetouched] = useState<string | null>(null),
    [voice, setVoice] = useState<string | null>(null);
  const [face, setFace] = useState<MouthRegion | null>(null),
    [mask, setMask] = useState<MouthRegion>({ x: 0.2, y: 0.55, width: 0.6, height: 0.4 }),
    [region, setRegion] = useState<'face' | 'mask'>('face');
  const [track, setTrack] = useState(false),
    [endX, setEndX] = useState(0),
    [endY, setEndY] = useState(0),
    [style, setStyle] = useState<'anime' | 'live'>('anime'),
    [feather, setFeather] = useState(0.12),
    [blend, setBlend] = useState(0.7),
    [seed, setSeed] = useState(0),
    [device, setDevice] = useState('');
  const [ratio, setRatio] = useState(16 / 9),
    [localTime, setLocalTime] = useState(0),
    [playing, setPlaying] = useState(false),
    [volume, setVolume] = useState(0.8),
    [working, setWorking] = useState(false),
    [jobId, setJobId] = useState<string | null>(null);
  const job =
    jobs.find((j) => j.id === jobId) ??
    jobs.find((j) => j.kind === 'inpaint' && ['running', 'queued'].includes(j.status));
  const origin = mode === 'original' ? (clip?.startMs ?? 0) : 0;
  const limit =
    mode === 'retouched' ? (edit?.durationMs ?? 0) : clip ? clip.endMs - clip.startMs : 0;
  const startRef = useRef(origin);
  startRef.current = origin;
  const pause = () => {
    video.current?.pause();
    audio.current?.pause();
  };
  const urlsKey = `${project.id}|${project.media?.path}|${clip?.cacheKey ?? ''}|${edit?.id ?? ''}|${mode}`;
  useEffect(() => {
    let disposed = false;
    video.current?.pause();
    audio.current?.pause();
    setRetouched(null);
    setVoice(null);
    setReady(false);
    const chosenTake =
      mode === 'retouched' && edit
        ? { id: edit.generationId, slot: edit.slotMs, exact: edit.exactDuration }
        : clip
          ? { id: clip.generation.id, slot: clip.slotMs, exact: clip.exactDuration }
          : null;
    const accept = (set: (v: string | null) => void) => (value: string | null) => {
      if (!disposed) set(value);
    };
    const fail = (e: unknown) => {
      if (!disposed) onError(String(e));
    };
    void bridge.mediaUrl(project).then(accept(setSource)).catch(fail);
    if (chosenTake)
      void bridge
        .dubbingUrl(
          chosenTake.id,
          chosenTake.slot,
          chosenTake.exact,
          project.voiceEdits?.[chosenTake.id],
        )
        .then(accept(setVoice))
        .catch(fail);
    if (edit) void bridge.inpaintUrl(edit.id).then(accept(setRetouched)).catch(fail);
    return () => {
      disposed = true;
    }; /* URLs are tied to the immutable take and its timing. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlsKey, onError]);
  useEffect(() => {
    if (runtime.status?.devices.length && !runtime.status.devices.some((d) => d.id === device))
      setDevice(
        runtime.status.devices.find((d) => d.name.includes('5060'))?.id ??
          runtime.status.devices[0].id,
      );
  }, [runtime.status, device]);
  useEffect(() => {
    const a = audio.current;
    if (a) a.volume = volume;
  }, [volume]);
  useEffect(() => {
    const v = video.current,
      a = audio.current;
    return () => {
      v?.pause();
      a?.pause();
    };
  }, []);
  const sync = () => {
    const v = video.current,
      a = audio.current;
    if (v && a) {
      const local = Math.max(0, v.currentTime - startRef.current / 1000);
      if (Math.abs(a.currentTime - local) > 0.08) a.currentTime = local;
    }
  };
  if (!line || !clip || !project.media) return <p className="panel-body">{t('lipsNeedsTake')}</p>;
  const busy = runtime.busy || working;
  const point = (x: number, y: number) => {
    const b = stage.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (x - b.left) / b.width)),
      y: Math.max(0, Math.min(1, (y - b.top) / b.height)),
    };
  };
  const changeMode = (next: 'original' | 'retouched') => {
    pause();
    setMode(next);
    setLocalTime(0);
  };
  const current = edit && currentLipVideo(project, edit);
  const fraction = limit > 0 ? Math.max(0, Math.min(1, localTime / limit)) : 0;
  const previewFace = face
    ? {
        ...face,
        x: face.x + (track ? endX - face.x : 0) * fraction,
        y: face.y + (track ? endY - face.y : 0) * fraction,
      }
    : null;
  const commonReady = !!face && face.width >= 0.01 && face.height >= 0.01;
  const options: InpaintOptions = {
    ...(runtime.modelId === 'musetalk-15-fp16'
      ? {}
      : { modelId: runtime.modelId, inferenceSteps, guidanceScale }),
    lineId: line.id,
    generationId: clip.generation.id,
    device,
    face: face ?? { x: 0.1, y: 0.1, width: 0.6, height: 0.8 },
    endX: track ? endX : (face?.x ?? 0.1),
    endY: track ? endY : (face?.y ?? 0.1),
    mask,
    feather,
    blend,
    style,
    seed,
  };
  return (
    <div className="panel-body inpaint-panel">
      {batch && (
        <>
          <p className="panel-description">{t('inpaintBatchFramingHint')}</p>
          <label className="field">
            <span>{t('inpaintBatchFrameLine')}</span>
            <select
              aria-label={t('inpaintBatchFrameLine')}
              value={line.id}
              disabled={busy}
              onChange={(event) => {
                pause();
                setFrameLineId(event.target.value);
                setMode('original');
                const saved =
                  preparedCrops[event.target.value] ??
                  lipVideos(project)
                    .filter(
                      (e) =>
                        e.dialogueId === event.target.value && e.sourcePath === project.media?.path,
                    )
                    .at(-1)?.options;
                setFace(saved?.face ?? null);
                if (saved) {
                  setMask(saved.mask);
                  setEndX(saved.endX);
                  setEndY(saved.endY);
                  setTrack(saved.endX !== saved.face.x || saved.endY !== saved.face.y);
                } else setTrack(false);
              }}
            >
              {clips.map((c) => (
                <option key={c.line.id} value={c.line.id}>
                  {project.dialogues.findIndex((l) => l.id === c.line.id) + 1} ·{' '}
                  {formatTime(c.startMs)} · {c.generation.text.slice(0, 65)}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <ModelCard runtime={runtime} />
      <p className="panel-description">
        {t('inpaintSequence', {
          start: formatTime(clip.startMs),
          end: formatTime(clip.endMs),
          seconds: ((clip.endMs - clip.startMs) / 1000).toFixed(2),
        })}
      </p>
      {runtime.modelId !== 'musetalk-15-fp16' && (
        <>
          <p className="panel-description">{t('latentMemoryProfile')}</p>
          <div className="lips-window">
            <label className="field">
              <span>{t('latentSteps')}</span>
              <input
                aria-label={t('latentSteps')}
                type="number"
                min="10"
                max="50"
                disabled={busy}
                value={inferenceSteps}
                onChange={(e) => setInferenceSteps(Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span>{t('latentGuidance')}</span>
              <input
                aria-label={t('latentGuidance')}
                type="number"
                min="1"
                max="3"
                step=".1"
                disabled={busy}
                value={guidanceScale}
                onChange={(e) => setGuidanceScale(Number(e.target.value))}
              />
            </label>
          </div>
          {style === 'anime' && <p className="warning">{t('latentAnimeHint')}</p>}
        </>
      )}
      <p className="panel-description">{t('inpaintHint')}</p>
      <label className="field">
        <span>{t('inpaintStyle')}</span>
        <select
          value={style}
          disabled={busy}
          onChange={(e) => {
            const value = e.target.value as 'anime' | 'live';
            setStyle(value);
            setBlend(value === 'anime' ? 0.7 : 1);
            setFeather(value === 'anime' ? 0.12 : 0.2);
          }}
        >
          <option value="anime">{t('inpaintAnime')}</option>
          <option value="live">{t('inpaintLive')}</option>
        </select>
      </label>
      <p className="panel-description">{t('inpaintStyleHint')}</p>
      <div className="inpaint-ab">
        <button
          className={`button ${mode === 'original' ? 'accent' : 'subtle'}`}
          onClick={() => changeMode('original')}
        >
          {t('inpaintBefore')}
        </button>
        <button
          className={`button ${mode === 'retouched' ? 'accent' : 'subtle'}`}
          disabled={!retouched}
          onClick={() => changeMode('retouched')}
        >
          {t('inpaintAfter')}
        </button>
      </div>
      <div className="mouth-stage" ref={stage} style={{ aspectRatio: ratio }}>
        {(mode === 'original' ? source : retouched) && (
          <video
            ref={video}
            key={`${mode}|${mode === 'original' ? source : retouched}`}
            src={(mode === 'original' ? source : retouched)!}
            muted
            playsInline
            preload="auto"
            onLoadedMetadata={() => {
              const v = video.current;
              if (v) {
                setRatio(v.videoWidth / v.videoHeight);
                v.currentTime = startRef.current / 1000;
              }
            }}
            onLoadedData={() => setReady(true)}
            onSeeked={() => {
              setReady(true);
              sync();
              if (video.current && !video.current.paused)
                void audio.current?.play().catch(() => onError('AUDIO_PLAYBACK_FAILED'));
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => {
              setPlaying(false);
              audio.current?.pause();
            }}
            onTimeUpdate={() => {
              const v = video.current;
              if (v) {
                const time = v.currentTime * 1000 - startRef.current;
                setLocalTime(time);
                if (time >= limit) {
                  pause();
                } else if (!v.paused) sync();
              }
            }}
            onSeeking={() => {
              audio.current?.pause();
            }}
            onError={() => onError('MEDIA_PLAYBACK_FAILED')}
          />
        )}
        {mode === 'original' && (
          <div
            className="mouth-selector"
            aria-label={t('inpaintSelector')}
            onPointerDown={(e) => {
              if (busy || e.button !== 0) return;
              if (localTime !== 0) {
                video.current!.currentTime = startRef.current / 1000;
                setLocalTime(0);
              }
              pause();
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = point(e.clientX, e.clientY);
            }}
            onPointerMove={(e) => {
              if (!drag.current || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
              const a = drag.current,
                b = point(e.clientX, e.clientY),
                r = {
                  x: Math.min(a.x, b.x),
                  y: Math.min(a.y, b.y),
                  width: Math.abs(a.x - b.x),
                  height: Math.abs(a.y - b.y),
                };
              if (region === 'face') {
                setFace(r);
                if (!track) {
                  setEndX(r.x);
                  setEndY(r.y);
                }
              } else if (face) {
                const x = Math.max(0, Math.min(1, (r.x - face.x) / face.width)),
                  y = Math.max(0, Math.min(1, (r.y - face.y) / face.height));
                setMask({
                  x,
                  y,
                  width: Math.min(1 - x, r.width / face.width),
                  height: Math.min(1 - y, r.height / face.height),
                });
              }
            }}
            onPointerUp={(e) => {
              drag.current = null;
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                e.currentTarget.releasePointerCapture(e.pointerId);
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            {previewFace && (
              <>
                <div
                  className="mouth-region face-region"
                  style={{
                    left: `${previewFace.x * 100}%`,
                    top: `${previewFace.y * 100}%`,
                    width: `${previewFace.width * 100}%`,
                    height: `${previewFace.height * 100}%`,
                  }}
                />
                <div
                  className="mouth-region"
                  style={{
                    left: `${(previewFace.x + previewFace.width * mask.x) * 100}%`,
                    top: `${(previewFace.y + previewFace.height * mask.y) * 100}%`,
                    width: `${previewFace.width * mask.width * 100}%`,
                    height: `${previewFace.height * mask.height * 100}%`,
                  }}
                />
              </>
            )}
          </div>
        )}
      </div>
      <audio
        ref={audio}
        src={voice ?? undefined}
        preload="auto"
        onError={() => onError('AUDIO_PLAYBACK_FAILED')}
      />
      <div className="lips-transport">
        <button
          className="button subtle"
          disabled={!ready || !voice || !source || (mode === 'retouched' && !retouched)}
          onClick={async () => {
            const v = video.current,
              a = audio.current;
            if (!v || !a) return;
            if (!v.paused) {
              pause();
              return;
            }
            try {
              if (v.currentTime * 1000 - startRef.current >= limit - 40)
                v.currentTime = startRef.current / 1000;
              sync();
              a.volume = volume;
              await v.play();
              sync();
              if (!v.paused) await a.play();
            } catch (e) {
              pause();
              if (!(e instanceof DOMException && e.name === 'AbortError')) onError(String(e));
            }
          }}
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}{' '}
          {t(playing ? 'pause' : 'inpaintAudition')}
        </button>
        <input
          type="range"
          aria-label={t('inpaintFrame')}
          min="0"
          max={Math.max(0, limit)}
          step="40"
          value={Math.max(0, Math.min(limit, localTime))}
          onChange={(e) => {
            pause();
            const time = Number(e.target.value);
            if (video.current) video.current.currentTime = (startRef.current + time) / 1000;
            setLocalTime(time);
            sync();
          }}
        />
        <span>{formatTime(clip.startMs + localTime)}</span>
      </div>
      <label className="field">
        <span>{t('inpaintVolume')}</span>
        <input
          type="range"
          min="0"
          max="1"
          step=".05"
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
        />
      </label>
      <label className="field">
        <span>{t('inpaintRegion')}</span>
        <select
          value={region}
          disabled={busy || mode === 'retouched'}
          onChange={(e) => setRegion(e.target.value as 'face' | 'mask')}
        >
          <option value="face">{t('inpaintFace')}</option>
          <option value="mask" disabled={!face}>
            {t('inpaintMask')}
          </option>
        </select>
      </label>
      <p className="panel-description">{t('inpaintRegionHint')}</p>
      <div className="mouth-coordinates">
        {(['x', 'y', 'width', 'height'] as const).map((key) => (
          <label className="field" key={key}>
            <span>{t(`lipsRegion.${key}`)} (%)</span>
            <input
              aria-label={`${t(region === 'face' ? 'inpaintFace' : 'inpaintMask')} ${t(`lipsRegion.${key}`)} (%)`}
              type="number"
              min="0"
              max="100"
              step=".1"
              disabled={busy || mode === 'retouched'}
              value={Math.round(((region === 'face' ? face : mask)?.[key] ?? 0) * 1000) / 10}
              onChange={(e) => {
                const r = {
                  ...(region === 'face' ? (face ?? { x: 0, y: 0, width: 0.4, height: 0.6 }) : mask),
                  [key]: Number(e.target.value) / 100,
                };
                if (region === 'face') {
                  setFace(r);
                  if (!track) {
                    setEndX(r.x);
                    setEndY(r.y);
                  }
                } else setMask(r);
              }}
            />
          </label>
        ))}
      </div>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={track}
          disabled={busy}
          onChange={(e) => {
            setTrack(e.target.checked);
            setEndX(face?.x ?? 0);
            setEndY(face?.y ?? 0);
          }}
        />
        {t('inpaintTrack')}
      </label>
      {track && (
        <>
          <p className="panel-description">{t('inpaintTrackHint')}</p>
          <div className="lips-window">
            {(['x', 'y'] as const).map((key) => (
              <label className="field" key={key}>
                <span>{t(key === 'x' ? 'inpaintEndX' : 'inpaintEndY')}</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step=".1"
                  disabled={busy}
                  value={Math.round((key === 'x' ? endX : endY) * 1000) / 10}
                  onChange={(e) => (key === 'x' ? setEndX : setEndY)(Number(e.target.value) / 100)}
                />
              </label>
            ))}
          </div>
        </>
      )}
      <label className="field">
        <span>
          {t('inpaintBlend')} · {Math.round(blend * 100)}%
        </span>
        <input
          type="range"
          min=".1"
          max="1"
          step=".05"
          value={blend}
          disabled={busy}
          onChange={(e) => setBlend(Number(e.target.value))}
        />
      </label>
      <label className="field">
        <span>
          {t('inpaintFeather')} · {Math.round(feather * 100)}%
        </span>
        <input
          type="range"
          min=".01"
          max=".45"
          step=".01"
          value={feather}
          disabled={busy}
          onChange={(e) => setFeather(Number(e.target.value))}
        />
      </label>
      <div className="lips-window">
        <label className="field">
          <span>{t('ttsDevice')}</span>
          <select value={device} disabled={busy} onChange={(e) => setDevice(e.target.value)}>
            {runtime.status?.devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} · {Math.round(d.memoryMb / 1024)} Go
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('ttsSeed')}</span>
          <input
            type="number"
            min="0"
            max="4294967295"
            value={seed}
            disabled={busy}
            onChange={(e) => setSeed(Number(e.target.value))}
          />
        </label>
      </div>
      {runtime.status?.installed && !runtime.status.devices.length && !busy && (
        <p className="warning">{t('inpaintNoCuda')}</p>
      )}
      {batch ? (
        <>
          <button
            className="button subtle wide"
            disabled={busy || !commonReady}
            onClick={() => {
              setCrops((previous) => ({
                ...previous,
                [line.id]: {
                  face: face!,
                  endX: track ? endX : face!.x,
                  endY: track ? endY : face!.y,
                  mask,
                },
              }));
            }}
          >
            {t('inpaintBatchSaveCrop', {
              number: project.dialogues.findIndex((l) => l.id === line.id) + 1,
            })}
          </button>
          <p>{t('inpaintBatchCropCount', { count: Object.keys(preparedCrops).length })}</p>
          <BatchInpaintAction
            project={project}
            selectedIds={batch.selectedIds}
            options={options}
            crops={preparedCrops}
            jobs={jobs}
            onDetectedCrops={(proposals) => {
              setDetected({
                revision: project.revision,
                sourcePath: project.media!.path,
                values: { ...detectedCrops, ...proposals },
              });
              const saved = proposals[line.id];
              if (saved && !crops[line.id]) {
                setFace(saved.face);
                setMask(saved.mask);
                setEndX(saved.endX);
                setEndY(saved.endY);
                setTrack(saved.endX !== saved.face.x || saved.endY !== saved.face.y);
              }
            }}
            busy={busy}
            ready={!!runtime.status?.installed && !!device}
            commonReady={commonReady}
            snapshot={snapshot}
            onStarted={onStarted ?? (() => {})}
            onError={onError}
          />
        </>
      ) : (
        <>
          <button
            className="button accent wide"
            disabled={
              !bridge.native ||
              busy ||
              !runtime.status?.installed ||
              !device ||
              !face ||
              face.width < 0.01 ||
              face.height < 0.01 ||
              limit < 200 ||
              clip.endMs - clip.startMs > inpaintLimit(runtime.modelId) ||
              (runtime.modelId !== 'musetalk-15-fp16' &&
                (!Number.isSafeInteger(inferenceSteps) ||
                  inferenceSteps < 10 ||
                  inferenceSteps > 50 ||
                  !Number.isFinite(guidanceScale) ||
                  guidanceScale < 1 ||
                  guidanceScale > 3))
            }
            onClick={async () => {
              if (!face) return;
              pause();
              setWorking(true);
              try {
                await snapshot();
                setJobId(
                  await bridge.inpaintLips({
                    ...(runtime.modelId === 'musetalk-15-fp16'
                      ? {}
                      : { modelId: runtime.modelId, inferenceSteps, guidanceScale }),
                    lineId: line.id,
                    generationId: clip.generation.id,
                    device,
                    face,
                    endX: track ? endX : face.x,
                    endY: track ? endY : face.y,
                    mask,
                    feather,
                    blend,
                    style,
                    seed,
                  }),
                );
              } catch (e) {
                onError(String(e));
              } finally {
                setWorking(false);
              }
            }}
          >
            {busy ? <LoaderCircle className="spin" size={15} /> : <ScanFace size={15} />}{' '}
            {t('inpaintGenerate')}
          </button>
          {job && ['running', 'queued'].includes(job.status) && (
            <div role="status">
              <p>{t(`jobStages.${job.stage}`)}</p>
              <progress value={job.progress ?? undefined} max="1" />
              <button
                className="text-button"
                onClick={() => void bridge.cancelJob(job.id).catch((e) => onError(String(e)))}
              >
                {t('cancel')}
              </button>
            </div>
          )}
          <p className="panel-description">
            {t(runtime.modelId === 'musetalk-15-fp16' ? 'inpaintLimits' : 'latentLimits')}
          </p>
          <h3>{t('inpaintVariants', { count: edits.length })}</h3>
          {edits.map((e, index) => (
            <div className="runtime-card" key={e.id}>
              <strong>
                {t('inpaintVariant', { number: index + 1 })} · {(e.durationMs / 1000).toFixed(2)} s
              </strong>
              <p>
                {inpaintModelLabel(e.options.modelId)} ·{' '}
                {t(e.options.style === 'anime' ? 'inpaintAnime' : 'inpaintLive')} ·{' '}
                {formatTime(e.startMs)}
              </p>
              <div className="inpaint-ab">
                <button
                  className="button subtle"
                  onClick={() => {
                    pause();
                    setChosen(e.id);
                    setMode('retouched');
                  }}
                >
                  {t('inpaintAfter')}
                </button>
                <button
                  className={`button ${e.enabled ? 'accent' : 'subtle'}`}
                  disabled={busy || (!e.enabled && !currentLipVideo(project, e))}
                  onClick={() => onEdit((p) => selectLipVideo(p, e.id, !e.enabled))}
                >
                  {t(e.enabled ? 'inpaintDisable' : 'inpaintEnable')}
                </button>
              </div>
              {!currentLipVideo(project, e) && <p className="warning">{t('inpaintStale')}</p>}
            </div>
          ))}
          {edit && !current && mode === 'retouched' && (
            <p className="warning">{t('inpaintStale')}</p>
          )}
        </>
      )}
      <p className="panel-description">{t('inpaintExportHint')}</p>
    </div>
  );
}
