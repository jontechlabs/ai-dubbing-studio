import { useEffect, useRef, useState } from 'react';
import { AudioLines, Captions, Film, Maximize, Minus, Plus, ScanLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Dialogue, Project } from '../domain/types';
import { timeToX, xToTime } from '../domain/time';
import { IconButton } from './IconButton';
import { moveCue, type SubtitleRole } from '../domain/timing';
import { Waveform } from './Waveform';
import { formatTime } from '../domain/time';

export function Timeline({
  project,
  selected,
  time,
  onSeek,
  onSelect,
  onEdit,
  busy,
}: {
  project: Project | null;
  selected: Dialogue | undefined;
  time: number;
  onSeek: (time: number) => void;
  onSelect: (line: Dialogue) => void;
  onEdit: (update: (p: Project) => Project) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const scroll = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(800);
  const [zoom, setZoom] = useState(1);
  const [rowHeight, setRowHeight] = useState(37);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [drag, setDrag] = useState<{
    id: string;
    role: SubtitleRole;
    x: number;
    start: number;
    end: number;
    startMs: number;
    endMs: number;
    edge: string;
  } | null>(null);
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
          <IconButton
            label={t('trackHeight')}
            onClick={() => setRowHeight(rowHeight === 37 ? 64 : 37)}
          >
            <AudioLines size={15} />
          </IconButton>
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
              <div className={`track-label ${style}`} key={key} style={{ height: rowHeight }}>
                <Icon size={13} />
                <span>{t(key)}</span>
              </div>
            ))}
          </div>
        </div>
        <div
          className="timeline-scroll"
          ref={scroll}
          onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
        >
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
              <div key={key} className={`timeline-track ${style}`} style={{ height: rowHeight }}>
                {style === 'video' || style === 'audio' ? (
                  <div
                    className="media-strip"
                    style={{ width: (project?.media?.durationMs ?? 0) * scale }}
                  >
                    {style === 'video' ? project?.media?.originalName : null}
                    {style === 'audio' && project?.media && (
                      <Waveform
                        key={project.media.id}
                        project={project}
                        scale={scale}
                        viewport={viewport}
                        scrollLeft={scrollLeft}
                        height={rowHeight - 4}
                      />
                    )}
                  </div>
                ) : (
                  (style === 'source' ? project?.sourceCues : project?.targetCues)?.map((cue) => {
                    const role = style as SubtitleRole;
                    const line = project!.dialogues.find((d) =>
                      (role === 'source' ? d.sourceCueIds : d.targetCueIds).includes(cue.id),
                    );
                    const range = drag?.id === cue.id && drag.role === role ? drag : cue;
                    if (!line) return null;
                    return (
                      <button
                        title={`${cue.text}\n${formatTime(range.startMs)} → ${formatTime(range.endMs)}\n${t('dragHint')}`}
                        aria-label={`${t(role === 'source' ? 'original' : 'displayedText')} ${project!.dialogues.indexOf(line) + 1}`}
                        key={cue.id}
                        disabled={busy}
                        className={`subtitle-block ${selected?.id === line.id ? 'selected' : ''}`}
                        style={{
                          left: range.startMs * scale,
                          width: Math.max(3, (range.endMs - range.startMs) * scale),
                        }}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          event.currentTarget.setPointerCapture(event.pointerId);
                          onSelect(line);
                          setDrag({
                            id: cue.id,
                            role,
                            x: event.clientX,
                            start: cue.startMs,
                            end: cue.endMs,
                            startMs: cue.startMs,
                            endMs: cue.endMs,
                            edge: (event.target as HTMLElement).dataset.edge ?? 'move',
                          });
                        }}
                        onPointerMove={(event) => {
                          if (
                            !drag ||
                            drag.id !== cue.id ||
                            !event.currentTarget.hasPointerCapture(event.pointerId)
                          )
                            return;
                          event.stopPropagation();
                          let delta = Math.round((event.clientX - drag.x) / scale);
                          const snap = (ms: number) => {
                            if (!event.shiftKey) return ms;
                            const edges = [
                              time,
                              ...[...project!.sourceCues, ...project!.targetCues]
                                .filter((c) => c.id !== cue.id)
                                .flatMap((c) => [c.startMs, c.endMs]),
                            ];
                            const nearest = edges.sort(
                              (a, b) => Math.abs(a - ms) - Math.abs(b - ms),
                            )[0];
                            return Math.abs(nearest - ms) <= 120 ? nearest : ms;
                          };
                          let startMs = drag.start,
                            endMs = drag.end;
                          if (drag.edge === 'start')
                            startMs = Math.max(
                              0,
                              Math.min(drag.end - 100, snap(drag.start + delta)),
                            );
                          else if (drag.edge === 'end')
                            endMs = Math.max(drag.start + 100, snap(drag.end + delta));
                          else {
                            delta = snap(drag.start + delta) - drag.start;
                            startMs = Math.max(0, drag.start + delta);
                            endMs = startMs + drag.end - drag.start;
                          }
                          setDrag({ ...drag, startMs, endMs });
                        }}
                        onPointerUp={(event) => {
                          event.stopPropagation();
                          if (drag && (drag.startMs !== cue.startMs || drag.endMs !== cue.endMs))
                            onEdit((p) => moveCue(p, role, cue.id, drag.startMs, drag.endMs));
                          setDrag(null);
                          if (event.currentTarget.hasPointerCapture(event.pointerId))
                            event.currentTarget.releasePointerCapture(event.pointerId);
                        }}
                        onPointerCancel={() => setDrag(null)}
                        onClick={() => {
                          if (!drag) onSelect(line);
                        }}
                        onKeyDown={(event) => {
                          if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
                          event.preventDefault();
                          const delta =
                            (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1000 : 100);
                          const start = Math.max(0, cue.startMs + delta);
                          onEdit((p) =>
                            moveCue(p, role, cue.id, start, start + cue.endMs - cue.startMs),
                          );
                        }}
                      >
                        <span data-edge="start" className="cue-handle start" />
                        {project!.dialogues.indexOf(line) + 1}
                        <span data-edge="end" className="cue-handle end" />
                      </button>
                    );
                  })
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
