import { JobDuration } from './JobDuration';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LoaderCircle, ScanLine, Play, Pause } from 'lucide-react';
import type { Dialogue, Job, Project } from '../domain/types';
import { dubbingClips } from '../domain/mix';
import { applyLipAnalysis, type LipAnalysis, type MouthRegion } from '../domain/lips';
import { formatTime, parseTime } from '../domain/time';
import * as bridge from '../services/bridge';
import { useAudioMix } from '../hooks/useAudioMix';

export function LipAnalysisPanel({
  project,
  line,
  jobs,
  snapshot,
  applySnapshot,
  onError,
}: {
  project: Project;
  line: Dialogue | undefined;
  jobs: Job[];
  snapshot: () => Promise<Project>;
  applySnapshot: (before: Project, after: Project) => Promise<void>;
  onError: (error: string) => void;
}) {
  const { t } = useTranslation();
  const clips = useMemo(() => dubbingClips(project), [project]);
  const clip = line && clips.find((c) => c.line.id === line.id);
  const clipIndex = clip ? clips.indexOf(clip) : -1;
  const minTime = clipIndex > 0 ? clips[clipIndex - 1].endMs : 0;
  const maxTime = clips[clipIndex + 1]?.startMs ?? project.media?.durationMs ?? 0;
  const currentProject = useRef(project);
  currentProject.current = project;
  const video = useRef<HTMLVideoElement>(null),
    stage = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const [url, setUrl] = useState<string | null>(null),
    [region, setRegion] = useState<MouthRegion | null>(null);
  const [ratio, setRatio] = useState(16 / 9),
    [frameTime, setFrameTime] = useState(clip?.startMs ?? line?.startMs ?? 0),
    [playing, setPlaying] = useState(false);
  const [start, setStart] = useState(
    formatTime(Math.max(minTime, (clip?.startMs ?? line?.startMs ?? 0) - 1000)),
  );
  const [end, setEnd] = useState(
    formatTime(Math.min(maxTime, Math.max(clip?.endMs ?? 0, line?.endMs ?? 0) + 1000)),
  );
  const [analysis, setAnalysis] = useState<LipAnalysis | null>(null),
    [working, setWorking] = useState(false),
    [id, setId] = useState<string | null>(null),
    [applied, setApplied] = useState(false),
    [accept, setAccept] = useState(false);
  const [previewVolume, setPreviewVolume] = useState(0.8),
    [preparing, setPreparing] = useState(false);
  const previewToken = useRef(0);
  const job = jobs.find((j) => j.id === id);
  const jobStatus = job?.status;
  const anyBusy = jobs.some((j) => ['queued', 'running', 'paused'].includes(j.status));
  const stale =
    !!analysis &&
    (analysis.projectId !== project.id ||
      analysis.revision !== project.revision ||
      analysis.sourcePath !== project.media?.path ||
      analysis.language !== project.languages.target ||
      analysis.options.generationId !== clip?.generation.id);
  const preview = useMemo(() => {
    const base: Project = {
      ...project,
      dialogues: line && analysis && !stale ? [line] : [],
      generations: clip ? [clip.generation] : [],
      tracks: [
        { id: 'original', kind: 'original', language: '', mute: true, solo: false, gain: 0 },
        {
          id: 'dubbing',
          kind: 'dubbing',
          language: project.languages.target,
          mute: false,
          solo: false,
          gain: 1,
        },
      ],
    };
    return analysis && !stale ? applyLipAnalysis(base, analysis) : base;
  }, [project, line, analysis, stale, clip]);
  const audition = useAudioMix(video, preview, url, previewVolume, onError);
  useEffect(() => {
    previewToken.current++;
    video.current?.pause();
  }, [analysis, stale]);
  useEffect(() => {
    let disposed = false;
    void bridge
      .mediaUrl(currentProject.current)
      .then((value) => {
        if (!disposed) setUrl(value);
      })
      .catch((e) => onError(String(e)));
    return () => {
      disposed = true;
    };
  }, [project.id, project.media?.path, onError]);
  useEffect(() => {
    if (!line?.id || !clip?.generation.id || !bridge.native) return;
    let disposed = false;
    void bridge
      .latestLipAnalysis(line.id, clip.generation.id)
      .then((value) => {
        if (!disposed) setId(value);
      })
      .catch((e) => {
        if (!disposed) onError(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [line?.id, clip?.generation.id, onError]);
  useEffect(() => {
    if (!id) return;
    const state = jobStatus;
    if (state === 'succeeded') {
      let disposed = false;
      void bridge
        .lipAnalysisResult(id)
        .then((value) => {
          if (!disposed) {
            setAnalysis(value);
            if (value) {
              setRegion(value.options.region);
              setStart(formatTime(value.options.startMs));
              setEnd(formatTime(value.options.endMs));
            }
            setWorking(false);
            setApplied(false);
          }
        })
        .catch((e) => {
          if (!disposed) {
            onError(String(e));
            setWorking(false);
          }
        });
      return () => {
        disposed = true;
      };
    }
    if (state === 'failed' || state === 'cancelled' || state === 'interrupted') setWorking(false);
  }, [id, jobStatus, onError]);
  if (!line || !clip || !project.media) return <p className="panel-body">{t('lipsNeedsTake')}</p>;
  const frameBounds = (() => {
    try {
      const first = parseTime(start),
        last = parseTime(end);
      if (first < last && last <= project.media!.durationMs) return { start: first, end: last };
    } catch {
      /* Leave malformed timecodes editable. */
    }
    return { start: 0, end: project.media!.durationMs };
  })();
  const frameInWindow = () => {
    const element = video.current;
    if (
      element &&
      (element.currentTime * 1000 < frameBounds.start ||
        element.currentTime * 1000 > frameBounds.end)
    ) {
      element.pause();
      element.currentTime = frameBounds.start / 1000;
    }
  };
  const invalidate = () => {
    setAnalysis(null);
    setApplied(false);
    setAccept(false);
  };
  const point = (x: number, y: number) => {
    const bounds = stage.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (x - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (y - bounds.top) / bounds.height)),
    };
  };
  const run = async () => {
    if (!region) return;
    setWorking(true);
    invalidate();
    video.current?.pause();
    try {
      const first = parseTime(start),
        last = parseTime(end);
      if (last - first < 1000 || last - first > 30000 || last > project.media!.durationMs)
        throw Error('LIPS_WINDOW_INVALID');
      await snapshot();
      setId(
        await bridge.analyzeLips({
          lineId: line.id,
          generationId: clip.generation.id,
          startMs: first,
          endMs: last,
          region,
        }),
      );
    } catch (e) {
      onError(String(e));
      setWorking(false);
    }
  };
  return (
    <div className="panel-body lips-panel">
      <p className="panel-description">{t('lipsHint')}</p>
      <div className="mouth-stage" ref={stage} style={{ aspectRatio: ratio }}>
        {url && (
          <video
            ref={video}
            src={url}
            crossOrigin="anonymous"
            muted
            playsInline
            preload="auto"
            onLoadedMetadata={() => {
              if (video.current) {
                setRatio(video.current.videoWidth / video.current.videoHeight);
                video.current.currentTime =
                  (clip.startMs + Math.min(300, clip.endMs - clip.startMs)) / 1000;
              }
            }}
            onTimeUpdate={() => {
              if (video.current) {
                const time = Math.round(video.current.currentTime * 1000);
                setFrameTime(time);
                try {
                  if (time >= parseTime(end)) video.current.pause();
                } catch {
                  /* Keep the frame inspectable while a timecode is being edited. */
                }
              }
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onError={() => onError('MEDIA_PLAYBACK_FAILED')}
          />
        )}
        <div
          className="mouth-selector"
          aria-label={t('lipsRegionSelection')}
          onPointerDown={(event) => {
            if (working || event.button !== 0) return;
            video.current?.pause();
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            pointer.current = point(event.clientX, event.clientY);
            invalidate();
            setRegion(null);
          }}
          onPointerMove={(event) => {
            if (!pointer.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const end = point(event.clientX, event.clientY),
              start = pointer.current;
            setRegion({
              x: Math.min(start.x, end.x),
              y: Math.min(start.y, end.y),
              width: Math.abs(end.x - start.x),
              height: Math.abs(end.y - start.y),
            });
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
            pointer.current = null;
          }}
          onPointerCancel={() => {
            pointer.current = null;
            setRegion(null);
          }}
        >
          {region && (
            <div
              className="mouth-region"
              style={{
                left: `${region.x * 100}%`,
                top: `${region.y * 100}%`,
                width: `${region.width * 100}%`,
                height: `${region.height * 100}%`,
              }}
            />
          )}
        </div>
      </div>
      <div className="lips-transport">
        <button
          className="button subtle"
          disabled={!url || working}
          onClick={() => {
            const element = video.current;
            if (element)
              void (element.paused ? element.play() : Promise.resolve(element.pause())).catch((e) =>
                onError(String(e)),
              );
          }}
        >
          {playing ? <Pause size={13} /> : <Play size={13} />} {t(playing ? 'pause' : 'play')}
        </button>
        <input
          aria-label={t('lipsFrame')}
          type="range"
          min={frameBounds.start}
          max={frameBounds.end}
          step="40"
          value={Math.max(frameBounds.start, Math.min(frameBounds.end, frameTime))}
          disabled={working}
          onChange={(event) => {
            const time = Number(event.target.value);
            if (video.current) video.current.currentTime = time / 1000;
            setFrameTime(time);
          }}
        />
        <span>{formatTime(frameTime)}</span>
      </div>
      <p className="panel-description">{t('lipsSelectHint')}</p>
      <div className="mouth-coordinates">
        {(['x', 'y', 'width', 'height'] as const).map((key) => (
          <label className="field" key={key}>
            <span>{t(`lipsRegion.${key}`)} (%)</span>
            <input
              aria-label={`${t(`lipsRegion.${key}`)} (%)`}
              type="number"
              min="0"
              max="100"
              step="0.1"
              disabled={working}
              value={region ? Math.round(region[key] * 1000) / 10 : ''}
              onChange={(event) => {
                invalidate();
                setRegion({
                  ...(region ?? { x: 0, y: 0, width: 0.1, height: 0.1 }),
                  [key]: Number(event.target.value) / 100,
                });
              }}
            />
          </label>
        ))}
      </div>
      <div className="lips-window">
        <label className="field">
          <span>{t('lipsWindowStart')}</span>
          <input
            value={start}
            onBlur={frameInWindow}
            disabled={working}
            onChange={(e) => {
              setStart(e.target.value);
              invalidate();
            }}
          />
        </label>
        <label className="field">
          <span>{t('lipsWindowEnd')}</span>
          <input
            value={end}
            onBlur={frameInWindow}
            disabled={working}
            onChange={(e) => {
              setEnd(e.target.value);
              invalidate();
            }}
          />
        </label>
      </div>
      <button
        className="button accent wide"
        disabled={
          !bridge.native ||
          anyBusy ||
          working ||
          !region ||
          region.width < 0.01 ||
          region.height < 0.01
        }
        onClick={() => void run()}
      >
        {working ? <LoaderCircle size={15} className="spin" /> : <ScanLine size={15} />}{' '}
        {t('lipsAnalyze')}
      </button>
      {working && (
        <div role="status">
          <p>{t('jobStages.lipsDecode')}</p>
          <progress max="1" value={job?.progress ?? undefined} />
          {job && <JobDuration job={job} />}
          <button
            className="text-button"
            disabled={!id}
            onClick={() => {
              if (id) void bridge.cancelJob(id).catch((e) => onError(String(e)));
            }}
          >
            {t('cancel')}
          </button>
        </div>
      )}
      {analysis && (
        <div className="lips-result">
          <h3>{t('lipsProposal')}</h3>
          <svg className="lips-chart" viewBox="0 0 600 120" role="img" aria-label={t('lipsChart')}>
            <path
              d={analysis.mouth
                .map(
                  (value, index) =>
                    `${index ? 'L' : 'M'}${(index / (analysis.mouth.length - 1)) * 600},${90 - value * 65}`,
                )
                .join(' ')}
              fill="none"
              stroke="var(--sage)"
              strokeWidth="2"
            />
            <path
              d={analysis.voice
                .map(
                  (value, index) =>
                    `${index ? 'L' : 'M'}${((analysis.startMs - analysis.options.startMs + (index / Math.max(1, analysis.voice.length - 1)) * analysis.durationMs) / (analysis.options.endMs - analysis.options.startMs)) * 600},${90 - value * 60}`,
                )
                .join(' ')}
              fill="none"
              stroke="var(--accent)"
              opacity="0.65"
              strokeWidth="1.5"
            />
            <rect
              x={
                ((analysis.startMs - analysis.options.startMs) /
                  (analysis.options.endMs - analysis.options.startMs)) *
                600
              }
              y="98"
              width={
                (analysis.durationMs / (analysis.options.endMs - analysis.options.startMs)) * 600
              }
              height="16"
              fill="var(--accent)"
            />
          </svg>
          <p className="panel-description">{t('lipsChartLegend')}</p>
          <p>
            {t('lipsProposedTimes', {
              start: formatTime(analysis.startMs),
              duration: (analysis.durationMs / 1000).toFixed(3),
            })}
          </p>
          <p className="panel-description">
            {t('lipsScore', {
              before: Math.round(analysis.currentScore * 100),
              after: Math.round(analysis.score * 100),
            })}
          </p>
          {analysis.warnings.map((warning) => (
            <p className="warning" key={warning}>
              {t(warning)}
            </p>
          ))}
          <button
            className="button subtle wide"
            disabled={working || stale || applied || preparing}
            onClick={async () => {
              const element = video.current,
                token = ++previewToken.current;
              if (!element) return;
              setPreparing(true);
              try {
                element.pause();
                element.currentTime =
                  Math.max(analysis.options.startMs, analysis.startMs - 200) / 1000;
                await audition.prepare(element.currentTime * 1000);
                if (previewToken.current === token && video.current === element)
                  await element.play();
              } catch (error) {
                onError(String(error));
              } finally {
                setPreparing(false);
              }
            }}
          >
            {preparing ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}{' '}
            {t('lipsAudition')}
          </button>
          <label className="field">
            <span>{t('lipsPreviewVolume')}</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={previewVolume}
              onChange={(event) => setPreviewVolume(Number(event.target.value))}
            />
          </label>
          {!analysis.reliable && (
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={accept}
                disabled={stale || applied}
                onChange={(e) => setAccept(e.target.checked)}
              />
              {t('lipsAcceptWeak')}
            </label>
          )}
          {stale && !applied && <p className="warning">{t('lipsStale')}</p>}
          <button
            className="button accent wide"
            disabled={working || anyBusy || stale || applied || (!analysis.reliable && !accept)}
            onClick={async () => {
              try {
                ++previewToken.current;
                video.current?.pause();
                await applySnapshot(project, applyLipAnalysis(project, analysis));
                setApplied(true);
              } catch (e) {
                onError(String(e));
              }
            }}
          >
            {t(applied ? 'lipsApplied' : 'lipsApply')}
          </button>
          <p className="panel-description">{t('lipsManualHint')}</p>
        </div>
      )}
      <div className="settings-section">
        <h3>{t('lipsVideoEdit')}</h3>
        <p className="panel-description">{t('lipsVideoEditHint')}</p>
      </div>
    </div>
  );
}
