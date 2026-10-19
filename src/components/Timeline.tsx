import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  AudioLines,
  Captions,
  Film,
  Maximize,
  Minus,
  Plus,
  ScanLine,
  Eye,
  EyeOff,
  Volume2,
  VolumeX,
  MousePointer2,
  Scissors,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TimelineNavigation } from '../domain/timeline';
import type { AudioSelection, Dialogue, Project, Track } from '../domain/types';
import { AudioQuickControls } from './AudioQuickControls';
import { timeToX, xToTime } from '../domain/time';
import { IconButton } from './IconButton';
import { moveCue, type SubtitleRole } from '../domain/timing';
import { Waveform } from './Waveform';
import { formatTime } from '../domain/time';
import {
  audioTracks,
  editTrack,
  audioResizeLimits,
  resizeAudioRegion,
  trackLabel,
} from '../domain/audio';
import { trackPatches } from '../domain/audioPatch';
import { subtitleDisplay, toggleSubtitles } from '../domain/subtitleDisplay';
import {
  dubbingClips,
  dubbingOffset,
  dubbingBounds,
  moveDubbing,
  resizeDubbing,
} from '../domain/mix';
import { useTimelineZoom } from '../hooks/useTimelineZoom';
import { VoiceRegionEditor } from './VoiceRegionEditor';
import { TimelineAudioSelection } from './TimelineAudioSelection';

export const Timeline = memo(function Timeline({
  project,
  navigation,
  selected,
  timeRef,
  onSeek,
  onSelect,
  onEdit,
  busy,
  onAudioSelection,
  audioSelection,
  onAudioAdvanced,
}: {
  project: Project | null;
  navigation?: TimelineNavigation | null;
  selected: Dialogue | undefined;
  timeRef: RefObject<number>;
  onSeek: (time: number) => void;
  onSelect: (line: Dialogue, positionMs?: number) => void;
  onEdit: (update: (p: Project) => Project) => void;
  busy: boolean;
  onAudioSelection: (selection: AudioSelection | null) => void;
  audioSelection: AudioSelection | null;
  onAudioAdvanced: () => void;
}) {
  const { t } = useTranslation();
  const scroll = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const [audioTool, setAudioTool] = useState(false);
  const [voiceEditor, setVoiceEditor] = useState<string | null>(null);
  const selectedVoice = project && dubbingClips(project).find((c) => c.line.id === selected?.id);
  const editingVoice =
    project && dubbingClips(project).find((c) => c.generation.id === voiceEditor);
  const [audioDrag, setAudioDrag] = useState<{
    trackId: string;
    anchor: number;
    end: number;
    regionId?: string;
  } | null>(null);
  const [audioResize, setAudioResize] = useState<{
    selection: AudioSelection;
    regionId?: string;
  } | null>(null);
  const audioResizeValue = useRef<AudioSelection | null>(null);
  useEffect(() => {
    if (!audioResize) return;
    const cancel = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onAudioSelection(audioResize.selection);
        setAudioResize(null);
        audioResizeValue.current = null;
      }
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [audioResize, onAudioSelection]);
  const associations = useMemo(() => {
    const source = new Map<string, Dialogue>(),
      target = new Map<string, Dialogue>(),
      numbers = new Map<string, number>();
    project?.dialogues.forEach((line, index) => {
      line.sourceCueIds.forEach((id) => source.set(id, line));
      line.targetCueIds.forEach((id) => target.set(id, line));
      numbers.set(line.id, index + 1);
    });
    return { source, target, numbers };
  }, [project]);
  const [viewport, setViewport] = useState(800);
  const [rowHeight, setRowHeight] = useState(37);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  useLayoutEffect(() => {
    if (audioSelection?.mediaId !== project?.media?.id) return;
    const row = Array.from(
      scroll.current?.querySelectorAll<HTMLElement>('.timeline-track') ?? [],
    ).find((row) => row.dataset.trackId === audioSelection?.trackId);
    row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [audioSelection?.trackId, audioSelection?.mediaId, project?.media?.id]);
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
  const [dubbingDrag, setDubbingDrag] = useState<{
    lineId: string;
    x: number;
    origin: number;
    offset: number;
    edge: 'move' | 'end';
    originDuration: number;
    duration: number;
  } | null>(null);
  // Drag previews are never allowed to throw during React rendering. A stale
  // project or a legacy collision may temporarily have no legal placement.
  const dubbingPreview = useMemo(() => {
    if (!project || !dubbingDrag) return project;
    try {
      return dubbingDrag.edge === 'end'
        ? resizeDubbing(project, dubbingDrag.lineId, dubbingDrag.duration)
        : moveDubbing(project, dubbingDrag.lineId, dubbingDrag.offset);
    } catch {
      return project;
    }
  }, [project, dubbingDrag]);
  const suppressDubbingClick = useRef(false);
  const duration = Math.max(
    project?.media?.durationMs ?? 0,
    ...(project?.dialogues.map((d) => d.endMs) ?? []),
    1000,
  );
  const view = useTimelineZoom(scroll, duration, viewport, timeRef, project?.id);
  const { zoom, reveal } = view;
  const revealedNavigation = useRef<TimelineNavigation | null>(null);
  const selectedVoiceStart = selectedVoice?.startMs;
  const selectedVoiceEnd = selectedVoice?.endMs;
  useLayoutEffect(() => {
    if (
      navigation &&
      navigation !== revealedNavigation.current &&
      navigation.projectId === project?.id &&
      navigation.lineId === selected?.id
    ) {
      reveal(
        selectedVoiceStart !== undefined && selectedVoiceEnd !== undefined
          ? {
              ...navigation,
              startMs: Math.min(navigation.startMs, selectedVoiceStart),
              endMs: Math.max(navigation.endMs, selectedVoiceEnd),
            }
          : navigation,
      );
      revealedNavigation.current = navigation;
    }
  }, [navigation, project?.id, selected?.id, selectedVoiceStart, selectedVoiceEnd, reveal]);
  useEffect(() => {
    setVoiceEditor((current) => (current ? (selectedVoice?.generation.id ?? null) : null));
  }, [selected?.id, selectedVoice?.generation.id]);
  useEffect(() => {
    if (!scroll.current) return;
    const observer = new ResizeObserver(([entry]) => setViewport(entry.contentRect.width));
    observer.observe(scroll.current);
    return () => observer.disconnect();
  }, []);
  const scale = (viewport * zoom) / duration;
  useEffect(() => {
    let frame = 0;
    let previous = -1;
    const draw = () => {
      const position = timeRef.current * scale;
      if (head.current && position !== previous) {
        head.current.style.transform = `translateX(${position}px)`;
        previous = position;
      }
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [scale, timeRef]);
  const resizePoint = (
    selection: AudioSelection,
    edge: 'start' | 'end',
    clientX: number,
    row: HTMLElement,
  ) => {
    const bounds = audioResizeLimits(project!, selection.trackId, selection.regionId);
    const point = Math.round((clientX - row.getBoundingClientRect().left) / scale);
    return {
      ...selection,
      startMs:
        edge === 'start'
          ? Math.max(bounds.min, Math.min(selection.endMs - 1, point))
          : selection.startMs,
      endMs:
        edge === 'end'
          ? Math.min(bounds.max, Math.max(selection.startMs + 1, point))
          : selection.endMs,
    };
  };
  const commitResize = (selection: AudioSelection, initial: AudioSelection) => {
    if (selection.startMs === initial.startMs && selection.endMs === initial.endMs) return;
    const region = audioResizeLimits(project!, initial.trackId, initial.regionId).region;
    if (region)
      onEdit((p) => {
        if (p.id !== project!.id || p.media?.id !== initial.mediaId) throw Error('STALE_REVISION');
        return resizeAudioRegion(p, initial.trackId, region.id, selection.startMs, selection.endMs);
      });
    onAudioSelection(selection);
  };
  const width = Math.max(viewport, duration * scale);
  const interval =
    [10, 20, 40, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000, 300000].find(
      (n) => n * scale >= 100,
    ) ?? 600000;
  const firstTick = Math.max(0, Math.floor(scrollLeft / scale / interval) * interval);
  const ticks = Array.from(
    { length: Math.min(100, Math.ceil(viewport / scale / interval) + 3) },
    (_, index) => firstTick + index * interval,
  ).filter((tick) => tick <= duration);
  const selectionZoom = () => {
    if (!selected) return;
    const clip = project && dubbingClips(project).find((c) => c.line.id === selected.id);
    view.focus(clip ? clip.startMs : selected.startMs, clip ? clip.endMs : selected.endMs);
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
  ]
    .map((track) => ({
      ...track,
      track: (track.key === 'originalTrack' && project ? audioTracks(project)[0] : undefined) as
        Track | undefined,
    }))
    .concat(
      (
        project?.tracks.filter(
          (track) => track.kind === 'audio' && track.sourcePath === project.media?.path,
        ) ?? []
      ).map((track) => ({
        key: `stem.${track.role}`,
        icon: AudioLines,
        style: 'audio',
        exists: true,
        track,
      })),
    )
    .concat(
      project
        ? audioTracks(project)
            .filter((t) => t.kind === 'dubbing')
            .map((track) => ({
              key: 'dubbingTrack',
              icon: AudioLines,
              style: 'audio',
              exists: true,
              track,
            }))
        : [],
    )
    .filter((track) => track.exists);
  return (
    <section className="timeline-pane">
      <div className="timeline-heading">
        <div>
          {project?.media && <AudioQuickControls project={project} onEdit={onEdit} compact />}
          <IconButton
            label={t('selectAudioArea')}
            active={audioTool}
            disabled={!project?.media || busy}
            onClick={() => setAudioTool((value) => !value)}
          >
            <MousePointer2 size={15} />
          </IconButton>
          <IconButton
            label={t('editVoiceRegion')}
            active={!!editingVoice}
            disabled={!selectedVoice || busy}
            onClick={() =>
              setVoiceEditor(
                voiceEditor === selectedVoice?.generation.id
                  ? null
                  : (selectedVoice?.generation.id ?? null),
              )
            }
          >
            <Scissors size={15} />
          </IconButton>
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
          <IconButton
            label={`${t('zoomOut')} (Ctrl+−)`}
            onClick={() => view.change(zoom / 1.5)}
            disabled={zoom === 1}
          >
            <Minus size={15} />
          </IconButton>
          <input
            className="timeline-zoom-slider"
            type="range"
            min="0"
            max="100"
            step="1"
            aria-label={t('timelineZoom')}
            value={view.maxZoom === 1 ? 0 : (Math.log(zoom) / Math.log(view.maxZoom)) * 100}
            onChange={(event) => view.change(view.maxZoom ** (Number(event.target.value) / 100))}
          />
          <span className="zoom-value" title={t('timelineZoomHint')}>
            {Math.round(zoom * 100)}%
          </span>
          <IconButton
            label={`${t('zoomIn')} (Ctrl++)`}
            onClick={() => view.change(zoom * 1.5)}
            disabled={zoom >= view.maxZoom}
          >
            <Plus size={15} />
          </IconButton>
          <span className="controls-divider" />
          <IconButton label={t('zoomSelection')} disabled={!selected} onClick={selectionZoom}>
            <ScanLine size={15} />
          </IconButton>
          <IconButton label={`${t('fit')} (Maj+Z)`} onClick={view.fit}>
            <Maximize size={15} />
          </IconButton>
        </div>
      </div>
      {project && audioSelection && (
        <TimelineAudioSelection
          key={`${project.id}:${audioSelection.mediaId}:${audioSelection.trackId}`}
          project={project}
          selection={audioSelection}
          busy={busy}
          onEdit={onEdit}
          onSelection={onAudioSelection}
          onAdvanced={onAudioAdvanced}
        />
      )}
      {project && editingVoice && (
        <VoiceRegionEditor
          key={`${project.id}:${editingVoice.generation.id}`}
          project={project}
          generation={editingVoice.generation}
          busy={busy}
          onEdit={onEdit}
          onClose={() => setVoiceEditor(null)}
        />
      )}
      <div className="timeline-body">
        <div className="track-labels">
          <div style={{ transform: `translateY(${-scrollTop}px)` }}>
            <div className="ruler-label" />
            <div>
              {tracks.map(({ key, icon: Icon, style, track }) => (
                <div className={`track-label ${style}`} key={key} style={{ height: rowHeight }}>
                  <Icon size={13} />
                  <span>{t(key)}</span>
                  {style === 'audio' && track && (
                    <div className="timeline-track-controls">
                      <button
                        title={t(track.mute ? 'enableTrack' : 'muteTrack', { name: t(key) })}
                        aria-label={t(track.mute ? 'enableTrack' : 'muteTrack', { name: t(key) })}
                        aria-pressed={!track.mute}
                        disabled={busy}
                        onClick={() => onEdit((p) => editTrack(p, track.id, { mute: !track.mute }))}
                      >
                        {track.mute ? <VolumeX size={12} /> : <Volume2 size={12} />}
                      </button>
                      <button
                        title={t('soloTrack', { name: t(key) })}
                        aria-label={t('soloTrack', { name: t(key) })}
                        aria-pressed={track.solo}
                        disabled={busy}
                        onClick={() => onEdit((p) => editTrack(p, track.id, { solo: !track.solo }))}
                      >
                        S
                      </button>
                    </div>
                  )}
                  {(style === 'source' || style === 'target') && project && (
                    <button
                      className="subtitle-eye"
                      title={t(
                        subtitleDisplay(project) === style || subtitleDisplay(project) === 'both'
                          ? 'hideSubtitles'
                          : 'showSubtitles',
                        { name: t(key) },
                      )}
                      aria-label={t(
                        subtitleDisplay(project) === style || subtitleDisplay(project) === 'both'
                          ? 'hideSubtitles'
                          : 'showSubtitles',
                        { name: t(key) },
                      )}
                      aria-pressed={
                        subtitleDisplay(project) === style || subtitleDisplay(project) === 'both'
                      }
                      disabled={busy}
                      onClick={() => onEdit((p) => toggleSubtitles(p, style as SubtitleRole))}
                    >
                      {subtitleDisplay(project) === style || subtitleDisplay(project) === 'both' ? (
                        <Eye size={13} />
                      ) : (
                        <EyeOff size={13} />
                      )}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div
          className="timeline-scroll"
          ref={scroll}
          onScroll={(event) => {
            setScrollLeft(event.currentTarget.scrollLeft);
            setScrollTop(event.currentTarget.scrollTop);
          }}
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
                  {formatTime(tick).slice(
                    duration >= 3_600_000 ? 0 : 3,
                    interval < 1000 ? undefined : -4,
                  )}
                </span>
              ))}
            </div>
            {tracks.map(({ key, style, track }) => (
              <div
                key={key}
                className={`timeline-track ${style} ${audioTool && track ? 'audio-selection-tool' : ''}`}
                data-track-id={track?.id}
                style={{ height: rowHeight }}
                onPointerDown={(event) => {
                  if (!track || busy || event.button !== 0 || (!audioTool && !event.shiftKey))
                    return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  const max = track.durationMs ?? project!.media!.durationMs;
                  const point = xToTime(
                    event.clientX - event.currentTarget.getBoundingClientRect().left,
                    0,
                    scale,
                    max,
                  );
                  setAudioDrag({
                    trackId: track.id,
                    anchor: point,
                    end: point,
                    regionId:
                      (event.target as HTMLElement)
                        .closest('[data-region-id]')
                        ?.getAttribute('data-region-id') ?? undefined,
                  });
                }}
                onPointerMove={(event) => {
                  if (
                    !track ||
                    audioDrag?.trackId !== track.id ||
                    !event.currentTarget.hasPointerCapture(event.pointerId)
                  )
                    return;
                  event.stopPropagation();
                  const max = track.durationMs ?? project!.media!.durationMs;
                  setAudioDrag({
                    ...audioDrag,
                    end: xToTime(
                      event.clientX - event.currentTarget.getBoundingClientRect().left,
                      0,
                      scale,
                      max,
                    ),
                  });
                }}
                onPointerUp={(event) => {
                  if (
                    !audioDrag ||
                    !track ||
                    !event.currentTarget.hasPointerCapture(event.pointerId)
                  )
                    return;
                  event.stopPropagation();
                  event.currentTarget.releasePointerCapture(event.pointerId);
                  if (Math.abs(audioDrag.end - audioDrag.anchor) >= 50)
                    onAudioSelection({
                      mediaId: project!.media!.id,
                      trackId: track.id,
                      startMs: Math.min(audioDrag.anchor, audioDrag.end),
                      endMs: Math.max(audioDrag.anchor, audioDrag.end),
                    });
                  else {
                    const region = track.regions?.find((r) => r.id === audioDrag.regionId);
                    if (region)
                      onAudioSelection({
                        mediaId: project!.media!.id,
                        trackId: track.id,
                        regionId: region.id,
                        startMs: region.startMs,
                        endMs: region.endMs,
                      });
                  }
                  setAudioDrag(null);
                }}
                onPointerCancel={() => setAudioDrag(null)}
              >
                {track?.kind === 'dubbing' && project ? (
                  dubbingClips(dubbingPreview ?? project)
                    .filter(
                      (c) =>
                        c.line.id === dubbingDrag?.lineId ||
                        (c.endMs * scale >= scrollLeft &&
                          c.startMs * scale <= scrollLeft + viewport),
                    )
                    .sort(
                      (a, b) =>
                        (associations.numbers.get(a.line.id) ?? 0) -
                        (associations.numbers.get(b.line.id) ?? 0),
                    )
                    .map((clip) => (
                      <button
                        key={clip.generation.id}
                        className={`subtitle-block dubbing-block ${selected?.id === clip.line.id ? 'selected' : ''} ${dubbingDrag?.lineId === clip.line.id ? 'moving' : ''}`}
                        style={{
                          left: clip.startMs * scale,
                          width: Math.max(3, (clip.endMs - clip.startMs) * scale),
                        }}
                        title={`${clip.generation.text}\n${formatTime(clip.startMs)} → ${formatTime(clip.endMs)}\n${t('dubbingDragHint')}`}
                        aria-label={`${t('dubbingTrack')} ${associations.numbers.get(clip.line.id)}`}
                        disabled={busy}
                        onPointerDown={(event) => {
                          if (audioTool || event.button !== 0) return;
                          event.preventDefault();
                          event.stopPropagation();
                          event.currentTarget.setPointerCapture(event.pointerId);
                          suppressDubbingClick.current = false;
                          const offset = dubbingOffset(project, clip.line.id);
                          setDubbingDrag({
                            lineId: clip.line.id,
                            x: event.clientX,
                            origin: offset,
                            offset,
                            edge: (event.target as HTMLElement).closest('.dubbing-resize')
                              ? 'end'
                              : 'move',
                            originDuration: Math.max(1, clip.endMs - clip.startMs),
                            duration: Math.max(1, clip.endMs - clip.startMs),
                          });
                        }}
                        onPointerMove={(event) => {
                          if (
                            !dubbingDrag ||
                            dubbingDrag.lineId !== clip.line.id ||
                            !event.currentTarget.hasPointerCapture(event.pointerId)
                          )
                            return;
                          event.stopPropagation();
                          if (Math.abs(event.clientX - dubbingDrag.x) > 3)
                            suppressDubbingClick.current = true;
                          if (dubbingDrag.edge === 'end') {
                            const bounds = dubbingBounds(project, clip.line.id);
                            if (bounds.max < bounds.min) return;
                            setDubbingDrag({
                              ...dubbingDrag,
                              duration: Math.max(
                                bounds.min,
                                Math.min(
                                  bounds.max,
                                  dubbingDrag.originDuration +
                                    Math.round((event.clientX - dubbingDrag.x) / scale),
                                ),
                              ),
                            });
                            return;
                          }
                          let start =
                            clip.line.startMs +
                            dubbingDrag.origin +
                            Math.round((event.clientX - dubbingDrag.x) / scale);
                          if (event.shiftKey) {
                            const points = [
                              0,
                              timeRef.current,
                              clip.line.startMs,
                              ...dubbingClips(project)
                                .filter((other) => other.line.id !== clip.line.id)
                                .flatMap((c) => [c.startMs, c.endMs]),
                            ];
                            const closest = points.reduce((best, point) =>
                              Math.abs(point - start) < Math.abs(best - start) ? point : best,
                            );
                            if (Math.abs(closest - start) * scale <= 10) start = closest;
                          }
                          const offset = Math.max(
                            -clip.line.startMs,
                            Math.min(
                              project.media!.durationMs - 1 - clip.line.startMs,
                              start - clip.line.startMs,
                            ),
                          );
                          setDubbingDrag({ ...dubbingDrag, offset });
                        }}
                        onPointerUp={(event) => {
                          if (!dubbingDrag || dubbingDrag.lineId !== clip.line.id) return;
                          event.stopPropagation();
                          if (
                            (dubbingDrag.offset !== dubbingDrag.origin ||
                              dubbingDrag.duration !== dubbingDrag.originDuration) &&
                            suppressDubbingClick.current
                          )
                            onEdit((p) =>
                              dubbingDrag.edge === 'end'
                                ? resizeDubbing(p, clip.line.id, dubbingDrag.duration)
                                : moveDubbing(p, clip.line.id, dubbingDrag.offset),
                            );
                          setDubbingDrag(null);
                          if (event.currentTarget.hasPointerCapture(event.pointerId))
                            event.currentTarget.releasePointerCapture(event.pointerId);
                        }}
                        onPointerCancel={() => {
                          setDubbingDrag(null);
                          suppressDubbingClick.current = true;
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape' && dubbingDrag) {
                            event.stopPropagation();
                            setDubbingDrag(null);
                            suppressDubbingClick.current = true;
                          }
                          if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
                            event.preventDefault();
                            event.stopPropagation();
                            onEdit((p) =>
                              moveDubbing(
                                p,
                                clip.line.id,
                                dubbingOffset(p, clip.line.id) +
                                  (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 10),
                              ),
                            );
                          }
                        }}
                        onDoubleClick={() => {
                          onSelect(clip.line, clip.startMs);
                          setVoiceEditor(clip.generation.id);
                        }}
                        onClick={() => {
                          if (!suppressDubbingClick.current) {
                            onSelect(clip.line, clip.startMs);
                          }
                          suppressDubbingClick.current = false;
                        }}
                      >
                        {associations.numbers.get(clip.line.id)}
                        <span className="dubbing-resize" title={t('dubbingResizeHint')} />
                      </button>
                    ))
                ) : style === 'video' || style === 'audio' ? (
                  <div
                    className="media-strip"
                    style={{
                      width: (track?.durationMs ?? project?.media?.durationMs ?? 0) * scale,
                    }}
                  >
                    {style === 'video' ? project?.media?.originalName : null}
                    {style === 'audio' && project?.media && (
                      <Waveform
                        key={track?.id ?? project.media.id}
                        project={project}
                        track={track?.kind === 'audio' ? track : undefined}
                        scale={scale}
                        viewport={viewport}
                        scrollLeft={scrollLeft}
                        height={rowHeight - 4}
                      />
                    )}
                  </div>
                ) : (
                  (style === 'source' ? project?.sourceCues : project?.targetCues)
                    ?.filter(
                      (cue) =>
                        (drag?.id === cue.id && drag.role === style) ||
                        (cue.endMs * scale >= scrollLeft &&
                          cue.startMs * scale <= scrollLeft + viewport),
                    )
                    .map((cue) => {
                      const role = style as SubtitleRole;
                      const line = associations[role].get(cue.id);
                      const range = drag?.id === cue.id && drag.role === role ? drag : cue;
                      if (!line) return null;
                      return (
                        <button
                          title={`${cue.text}\n${formatTime(range.startMs)} → ${formatTime(range.endMs)}\n${t('dragHint')}`}
                          aria-label={`${t(role === 'source' ? 'original' : 'displayedText')} ${associations.numbers.get(line.id)}`}
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
                                timeRef.current,
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
                          {associations.numbers.get(line.id)}
                          <span data-edge="end" className="cue-handle end" />
                        </button>
                      );
                    })
                )}
                {track &&
                  (track.regions ?? [])
                    .filter(
                      (region) =>
                        region.endMs * scale >= scrollLeft &&
                        region.startMs * scale <= scrollLeft + viewport,
                    )
                    .map((region, index) => (
                      <button
                        key={region.id}
                        data-region-id={region.id}
                        className={`audio-region ${region.mute || region.gain === 0 ? 'silent' : 'audible'} ${track.regionsEnabled === false ? 'bypassed' : ''}`}
                        style={{
                          left: region.startMs * scale,
                          width: Math.max(3, (region.endMs - region.startMs) * scale),
                        }}
                        title={`${formatTime(region.startMs)} → ${formatTime(region.endMs)} · ${region.mute ? t('regionMuted') : Math.round(region.gain * 100) + '%'}`}
                        aria-label={t('timelineAudioRegion', { name: t(key), index: index + 1 })}
                        disabled={busy}
                        onPointerDown={(event) => {
                          if (!audioTool && !event.shiftKey) event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (audioTool || event.shiftKey) return;
                          onAudioSelection({
                            mediaId: project!.media!.id,
                            trackId: track.id,
                            regionId: region.id,
                            startMs: region.startMs,
                            endMs: region.endMs,
                          });
                        }}
                      >
                        {region.mute || region.gain === 0 ? (
                          <VolumeX size={10} />
                        ) : (
                          Math.round(region.gain * 100) + '%'
                        )}
                      </button>
                    ))}
                {track &&
                  project &&
                  trackPatches(project, track.id)
                    .filter(
                      (e) =>
                        e.endMs * scale >= scrollLeft && e.startMs * scale <= scrollLeft + viewport,
                    )
                    .map((e) => (
                      <button
                        key={e.id}
                        className={`audio-patch ${e.mode === 'silence' ? 'cut' : ''}`}
                        title={`${t(`transfer.${e.operation}`)} · ${formatTime(e.startMs)} → ${formatTime(e.endMs)}`}
                        aria-label={`${t(`transfer.${e.operation}`)} ${t(key)} ${formatTime(e.startMs)}`}
                        style={{
                          left: e.startMs * scale,
                          width: Math.max(3, (e.endMs - e.startMs) * scale),
                        }}
                        onPointerDown={(event) => {
                          if (!audioTool && !event.shiftKey) event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          onAudioSelection({
                            mediaId: project.media!.id,
                            trackId: track.id,
                            startMs: e.startMs,
                            endMs: e.endMs,
                          });
                        }}
                      >
                        {e.mode === 'silence' ? '×' : '↔'}
                      </button>
                    ))}
                {track &&
                  !audioDrag &&
                  audioSelection?.mediaId === project?.media?.id &&
                  audioSelection?.trackId === track.id && (
                    <div
                      className="audio-range-selection persistent"
                      style={{
                        left: audioSelection.startMs * scale,
                        width: Math.max(2, (audioSelection.endMs - audioSelection.startMs) * scale),
                      }}
                    >
                      {(['start', 'end'] as const).map((edge) => (
                        <button
                          key={edge}
                          className={`audio-selection-edge ${edge}`}
                          disabled={busy}
                          aria-label={t(edge === 'start' ? 'audioResizeStart' : 'audioResizeEnd', {
                            track: t(trackLabel(track)),
                          })}
                          onClick={(e) => e.stopPropagation()}
                          onPointerDown={(e) => {
                            if (e.button !== 0) return;
                            e.preventDefault();
                            e.stopPropagation();
                            e.currentTarget.setPointerCapture(e.pointerId);
                            setAudioResize({
                              selection: { ...audioSelection },
                              regionId: audioSelection.regionId,
                            });
                            audioResizeValue.current = { ...audioSelection };
                          }}
                          onPointerMove={(e) => {
                            if (!audioResize || !e.currentTarget.hasPointerCapture(e.pointerId))
                              return;
                            e.stopPropagation();
                            const value = resizePoint(
                              audioResize.selection,
                              edge,
                              e.clientX,
                              e.currentTarget.closest('.timeline-track') as HTMLElement,
                            );
                            audioResizeValue.current = value;
                            onAudioSelection(value);
                          }}
                          onPointerUp={(e) => {
                            if (!audioResize || !e.currentTarget.hasPointerCapture(e.pointerId))
                              return;
                            e.stopPropagation();
                            if (audioResizeValue.current)
                              commitResize(audioResizeValue.current, audioResize.selection);
                            setAudioResize(null);
                            audioResizeValue.current = null;
                            e.currentTarget.releasePointerCapture(e.pointerId);
                          }}
                          onPointerCancel={() => {
                            if (audioResize) onAudioSelection(audioResize.selection);
                            setAudioResize(null);
                            audioResizeValue.current = null;
                          }}
                          onKeyDown={(e) => {
                            if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
                            e.preventDefault();
                            e.stopPropagation();
                            const bounds = audioResizeLimits(
                                project!,
                                track.id,
                                audioSelection.regionId,
                              ),
                              delta = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 10);
                            const value = {
                              ...audioSelection,
                              startMs:
                                edge === 'start'
                                  ? Math.max(
                                      bounds.min,
                                      Math.min(
                                        audioSelection.endMs - 1,
                                        audioSelection.startMs + delta,
                                      ),
                                    )
                                  : audioSelection.startMs,
                              endMs:
                                edge === 'end'
                                  ? Math.min(
                                      bounds.max,
                                      Math.max(
                                        audioSelection.startMs + 1,
                                        audioSelection.endMs + delta,
                                      ),
                                    )
                                  : audioSelection.endMs,
                            };
                            commitResize(value, audioSelection);
                          }}
                        />
                      ))}
                    </div>
                  )}
                {track && audioDrag?.trackId === track.id && (
                  <div
                    className="audio-range-selection"
                    style={{
                      left: Math.min(audioDrag.anchor, audioDrag.end) * scale,
                      width: Math.max(2, Math.abs(audioDrag.end - audioDrag.anchor) * scale),
                    }}
                  />
                )}
              </div>
            ))}
            {!tracks.length && <div className="empty-timeline">{t('emptyTimeline')}</div>}
            <div className="playhead" ref={head} style={{ left: 0 }}>
              <span />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
});
