import { useEffect, useRef, useState } from 'react';
import { AudioLines, Captions, Film, Maximize, Minus, Plus, ScanLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Dialogue, Project } from '../domain/types';
import { timeToX, xToTime } from '../domain/time';
import { IconButton } from './IconButton';

export function Timeline({
  project,
  selected,
  time,
  onSeek,
  onSelect,
}: {
  project: Project | null;
  selected: Dialogue | undefined;
  time: number;
  onSeek: (time: number) => void;
  onSelect: (line: Dialogue) => void;
}) {
  const { t } = useTranslation();
  const scroll = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(800);
  const [zoom, setZoom] = useState(1);
  const duration = Math.max(
    project?.media?.durationMs ?? 0,
    ...(project?.dialogues.map((d) => d.endMs) ?? []),
    1000,
  );
  useEffect(() => {
    if (!scroll.current) return;
    const observer = new ResizeObserver(([entry]) => setViewport(entry.contentRect.width));
    observer.observe(scroll.current);
    return () => observer.disconnect();
  }, []);
  const scale = (viewport * zoom) / duration;
  const width = Math.max(viewport, duration * scale);
  const interval =
    [1000, 2000, 5000, 10000, 30000, 60000, 120000, 300000].find((n) => n * scale >= 85) ?? 600000;
  const ticks = Array.from(
    { length: Math.min(3000, Math.ceil(duration / interval) + 1) },
    (_, index) => index * interval,
  );
  const selectionZoom = () => {
    if (!selected) return;
    const value = Math.min(100, duration / Math.max(4000, (selected.endMs - selected.startMs) * 3));
    setZoom(value);
    requestAnimationFrame(() =>
      scroll.current?.scrollTo({
        left: Math.max(0, ((selected.startMs - 1000) * viewport * value) / duration),
      }),
    );
  };
  const seek = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    onSeek(xToTime(event.clientX - bounds.left, 0, scale, duration));
  };
  const tracks = [
    { key: 'videoTrack', icon: Film, style: 'video', exists: Boolean(project?.media) },
    { key: 'originalTrack', icon: AudioLines, style: 'audio', exists: Boolean(project?.media) },
    {
      key: 'sourceTrack',
      icon: Captions,
      style: 'source',
      exists: Boolean(project?.sourceCues.length),
    },
    {
      key: 'targetTrack',
      icon: Captions,
      style: 'target',
      exists: Boolean(project?.targetCues.length),
    },
  ].filter((track) => track.exists);
  return (
    <section className="timeline-pane">
      <div className="timeline-heading">
        <div>
          <AudioLines size={16} />
          <h2>{t('timeline')}</h2>
          <span className="timeline-language">
            {project?.languages.source.toUpperCase()} <span>→</span>{' '}
            {project?.languages.target.toUpperCase()}
          </span>
        </div>
        <div>
          <IconButton label={t('zoomOut')} onClick={() => setZoom(Math.max(1, zoom / 1.5))}>
            <Minus size={15} />
          </IconButton>
          <span className="zoom-value">{Math.round(zoom * 100)}%</span>
          <IconButton label={t('zoomIn')} onClick={() => setZoom(Math.min(100, zoom * 1.5))}>
            <Plus size={15} />
          </IconButton>
          <span className="controls-divider" />
          <IconButton label={t('zoomSelection')} disabled={!selected} onClick={selectionZoom}>
            <ScanLine size={15} />
          </IconButton>
          <IconButton
            label={t('fit')}
            onClick={() => {
              setZoom(1);
              scroll.current?.scrollTo({ left: 0 });
            }}
          >
            <Maximize size={15} />
          </IconButton>
        </div>
      </div>
      <div className="timeline-body">
        <div className="track-labels">
          <div className="ruler-label" />
          <div>
            {tracks.map(({ key, icon: Icon, style }) => (
              <div className={`track-label ${style}`} key={key}>
                <Icon size={13} />
                <span>{t(key)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="timeline-scroll" ref={scroll}>
          <div
            className="timeline-content"
            style={{ width }}
            onPointerDown={(event) => {
              if (!(event.target as HTMLElement).closest('button')) {
                event.currentTarget.setPointerCapture(event.pointerId);
                seek(event);
              }
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId) && event.buttons === 1)
                seek(event);
            }}
          >
            <div className="ruler">
              {ticks.map((tick) => (
                <span key={tick} style={{ left: timeToX(tick, 0, scale) }}>
                  {Math.floor(tick / 60000)
                    .toString()
                    .padStart(2, '0')}
                  :
                  {Math.floor((tick / 1000) % 60)
                    .toString()
                    .padStart(2, '0')}
                </span>
              ))}
            </div>
            {tracks.map(({ key, style }) => (
              <div key={key} className={`timeline-track ${style}`}>
                {style === 'video' || style === 'audio' ? (
                  <div
                    className="media-strip"
                    style={{ width: (project?.media?.durationMs ?? 0) * scale }}
                  >
                    {style === 'video' ? project?.media?.originalName : t('original')}
                  </div>
                ) : (
                  project?.dialogues
                    .filter(
                      (line) =>
                        (style === 'source' ? line.sourceCueIds : line.targetCueIds).length > 0,
                    )
                    .map((line) => (
                      <button
                        title={t('selectedLine', { index: project.dialogues.indexOf(line) + 1 })}
                        key={line.id}
                        className={`subtitle-block ${selected?.id === line.id ? 'selected' : ''}`}
                        style={{
                          left: line.startMs * scale,
                          width: Math.max(3, (line.endMs - line.startMs) * scale),
                        }}
                        onClick={() => onSelect(line)}
                      >
                        {project.dialogues.indexOf(line) + 1}
                      </button>
                    ))
                )}
              </div>
            ))}
            {!tracks.length && <div className="empty-timeline">{t('emptyTimeline')}</div>}
            <div className="playhead" style={{ left: time * scale }}>
              <span />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
