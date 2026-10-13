import {
  AudioLines,
  ArrowUpRight,
  Film,
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
import type { Project } from '../domain/types';
import type { Transport } from '../hooks/useTransport';
import { formatTime } from '../domain/time';
import { IconButton } from './IconButton';

export function Player({
  project,
  transport,
  onImport,
  onOpen,
  onDemo,
  onStep,
  onAudio,
}: {
  project: Project | null;
  transport: Transport;
  onImport: () => void;
  onOpen: () => void;
  onDemo: () => void;
  onStep: (offset: number) => void;
  onAudio: () => void;
}) {
  const { t } = useTranslation();
  const activeText = project?.targetCues
    .filter((cue) => transport.time >= cue.startMs && transport.time < cue.endMs)
    .map((cue) => cue.text.replace(/<[^>]*>/g, ''))
    .join('\n');
  const contentRef = transport.videoRef;
  return (
    <div className="player-pane">
      <div className="pane-heading player-heading">
        <div>
          <Film size={16} />
          <h2>{project?.media?.originalName ?? t('preview')}</h2>
        </div>
        <span className="player-mode">
          <AudioLines size={12} />
          {t('original')}
        </span>
      </div>
      <div className={`video-stage ${transport.url ? 'has-video' : ''}`}>
        {transport.url ? (
          <>
            <video
              ref={contentRef}
              src={transport.url}
              playsInline
              preload="auto"
              onLoadedMetadata={transport.loaded}
              onPlay={transport.onPlay}
              onPause={transport.onPause}
              onTimeUpdate={transport.onTime}
              onError={onAudio}
              onClick={transport.toggle}
            />
            <div className="subtitle-overlay">{activeText}</div>
          </>
        ) : (
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
            disabled={!transport.url}
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
