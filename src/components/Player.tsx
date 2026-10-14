import {
  AudioLines,
  ArrowUpRight,
  Film,
  LoaderCircle,
  FolderOpen,
  Maximize2,
  Pause,
  Play,
  Repeat2,
  SkipBack,
  SkipForward,
  Volume2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Job, Project } from '../domain/types';
import type { Transport } from '../hooks/useTransport';
import { formatTime } from '../domain/time';
import { IconButton } from './IconButton';
import { useMemo } from 'react';
import { cueIndex } from '../domain/cueIndex';
import {
  setSubtitleDisplay,
  subtitleDisplay,
  type SubtitleDisplay,
} from '../domain/subtitleDisplay';

export function Player({
  project,
  transport,
  onImport,
  onOpen,
  onDemo,
  onStep,
  onAudio,
  importJob,
  onJobs,
  onEdit,
}: {
  project: Project | null;
  transport: Transport;
  onImport: () => void;
  onOpen: () => void;
  onDemo: () => void;
  onStep: (offset: number) => void;
  onAudio: () => void;
  importJob?: Job;
  onJobs: () => void;
  onEdit: (update: (project: Project) => Project) => void;
}) {
  const { t } = useTranslation();
  const activeCues = useMemo(() => cueIndex(project?.targetCues ?? []), [project?.targetCues]);
  const sourceCues = useMemo(() => cueIndex(project?.sourceCues ?? []), [project?.sourceCues]);
  const mode = project ? subtitleDisplay(project) : 'off';
  const activeText = [
    ...(mode === 'source' || mode === 'both' ? sourceCues(transport.time) : []),
    ...(mode === 'target' || mode === 'both' ? activeCues(transport.time) : []),
  ]
    .map((cue) => cue.text.replace(/<[^>]*>/g, ''))
    .join('\n');
  const contentRef = transport.videoRef;
  const loading =
    !!importJob ||
    (!!project?.media && !transport.failed && (!transport.ready || transport.buffering));
  return (
    <div className="player-pane">
      <div className="pane-heading player-heading">
        <div>
          <Film size={16} />
          <h2>{project?.media?.originalName ?? t('preview')}</h2>
        </div>
        <span className="player-mode">
          <AudioLines size={12} />
          {t(project?.tracks.some((track) => track.kind === 'audio') ? 'audioMix' : 'original')}
        </span>
      </div>
      <div className={`video-stage ${transport.url ? 'has-video' : ''}`} aria-busy={loading}>
        {transport.url ? (
          <>
            <video
              crossOrigin="anonymous"
              key={`${project?.media?.id}|${transport.url}`}
              muted={transport.originalMuted}
              ref={contentRef}
              src={transport.url}
              playsInline
              preload="auto"
              onLoadedMetadata={transport.loaded}
              onLoadedData={transport.onReady}
              onCanPlay={transport.onReady}
              onWaiting={transport.onWaiting}
              onPlay={transport.onPlay}
              onPause={transport.onPause}
              onTimeUpdate={transport.onTime}
              onError={transport.onError}
              onClick={transport.toggle}
            />
            <div className="subtitle-overlay">{activeText}</div>
          </>
        ) : !loading && !transport.failed ? (
          <div className="welcome">
            <div className="welcome-art">
              <div className="orbit orbit-one" />
              <div className="orbit orbit-two" />
              <div className="wave-mark">
                <AudioLines size={60} strokeWidth={1.3} />
              </div>
              <div className="orbit-point" />
            </div>
            <div className="eyebrow">{t('local')}</div>
            <h1>{t('emptyTitle')}</h1>
            <p>{t('emptyHint')}</p>
            <div className="welcome-buttons">
              <button className="button accent" onClick={onImport}>
                <FolderOpen size={16} />
                {t('importVideo')}
              </button>
              <button className="button subtle" onClick={onOpen}>
                {t('open')}
              </button>
            </div>
            <button className="demo-button" onClick={onDemo}>
              {t('demo')}
              <ArrowUpRight size={14} />
            </button>
          </div>
        ) : null}
        {loading && (
          <div className="video-loading" role="status" aria-live="polite">
            <LoaderCircle size={36} className="spin" />
            <strong>{t(importJob ? 'preparingVideo' : 'loadingVideo')}</strong>
            <span>
              {importJob
                ? t(importJob.status === 'queued' ? 'jobQueued' : `jobStages.${importJob.stage}`)
                : t('loadingVideoHint')}
            </span>
            {importJob && (
              <>
                <progress
                  aria-label={t('videoImportProgress')}
                  value={importJob.progress ?? undefined}
                  max="1"
                />
                {importJob.progress !== null && (
                  <span>{Math.round(importJob.progress * 100)}%</span>
                )}
                <button className="button subtle" onClick={onJobs}>
                  {t('showProcessing')}
                </button>
              </>
            )}
          </div>
        )}
        {transport.failed && !importJob && (
          <div className="video-loading video-load-error" role="status">
            <Film size={32} />
            <strong>{t('videoLoadError')}</strong>
            <button className="button subtle" onClick={onAudio}>
              {t('prepareProxy')}
            </button>
          </div>
        )}
      </div>
      <div className="player-controls">
        <div className="transport-buttons">
          <IconButton
            label={t('previous')}
            onClick={() => onStep(-1)}
            disabled={!project?.dialogues.length}
          >
            <SkipBack size={16} />
          </IconButton>
          <IconButton
            label={t(transport.playing ? 'pause' : 'play')}
            onClick={transport.toggle}
            disabled={!transport.ready || !!importJob}
          >
            <span className="play-icon">
              {transport.playing ? (
                <Pause size={18} fill="currentColor" />
              ) : (
                <Play size={18} fill="currentColor" />
              )}
            </span>
          </IconButton>
          <IconButton
            label={t('next')}
            onClick={() => onStep(1)}
            disabled={!project?.dialogues.length}
          >
            <SkipForward size={16} />
          </IconButton>
          <span className="controls-divider" />
          <IconButton
            label={t('loop')}
            active={transport.loop}
            onClick={() => transport.setLoop(!transport.loop)}
          >
            <Repeat2 size={16} />
          </IconButton>
        </div>
        <div className="player-time">
          {formatTime(transport.time)}
          <span>/ {formatTime(project?.media?.durationMs ?? 0)}</span>
        </div>
        <div className="volume-control">
          <select
            className="subtitle-preview-select"
            aria-label={t('subtitlePreview')}
            value={mode}
            disabled={!project}
            onChange={(event) =>
              onEdit((p) => setSubtitleDisplay(p, event.target.value as SubtitleDisplay))
            }
          >
            <option value="off">{t('subtitlesOff')}</option>
            <option value="source">{t('original')}</option>
            <option value="target">{t('translated')}</option>
            <option value="both">{t('timingBoth')}</option>
          </select>
          <Volume2 size={15} />
          <input
            aria-label={t('volume')}
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={transport.volume}
            onChange={(e) => transport.setVolume(Number(e.target.value))}
          />
          <IconButton
            label={t('fullscreen')}
            disabled={!transport.url}
            onClick={() => {
              void contentRef.current?.parentElement?.requestFullscreen();
            }}
          >
            <Maximize2 size={16} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
