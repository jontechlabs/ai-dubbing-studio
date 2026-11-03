import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImagePlus, LoaderCircle, Pause, Play, ScanFace } from 'lucide-react';
import type { Character, Project } from '../domain/types';
import {
  portraitDraw,
  portraitMove,
  portraitRectValid,
  portraitResize,
  type PortraitRect,
  type PortraitPreviewOptions,
} from '../domain/portraitFrame';
import { formatTime } from '../domain/time';
import * as bridge from '../services/bridge';
import { Modal } from './Modal';

type Frame = Awaited<ReturnType<typeof bridge.previewCharacterPortrait>>;
type Point = { x: number; y: number };
type Drag = { kind: string; start: Point; initial: PortraitRect | null };
export function CharacterPortraitModal({
  project,
  character,
  lineId: initialLineId,
  atMs,
  initialCrop,
  busy,
  snapshot,
  onCapture,
  onClose,
  onAudition,
}: {
  project: Project;
  character: Character;
  lineId: string;
  atMs: number;
  initialCrop?: PortraitRect;
  busy: boolean;
  snapshot: () => Promise<Project>;
  onCapture: (options: bridge.PortraitOptions) => Promise<void>;
  onClose: () => void;
  onAudition: () => void;
}) {
  const { t } = useTranslation();
  const [lineId, setLine] = useState(initialLineId),
    [time, setTime] = useState(atMs),
    [url, setUrl] = useState('');
  const [profile, setProfile] = useState<PortraitPreviewOptions['profile']>('auto');
  const [frame, setFrame] = useState<Frame | null>(null),
    [crop, setCrop] = useState<PortraitRect | null>(initialCrop ?? null);
  const [working, setWorking] = useState(false),
    [saving, setSaving] = useState(false),
    [playing, setPlaying] = useState(false),
    [error, setError] = useState('');
  const [ratio, setRatio] = useState('16 / 9');
  const video = useRef<HTMLVideoElement>(null),
    stage = useRef<HTMLDivElement>(null),
    drag = useRef<Drag | null>(null);
  const serial = useRef(0),
    pending = useRef(false),
    alive = useRef(true),
    desired = useRef(atMs);
  const maxTime = Math.max(0, (project.media?.durationMs ?? 1) - 1);
  const current =
    !!frame &&
    frame.projectId === project.id &&
    frame.revision === project.revision &&
    frame.sourcePath === project.media?.path &&
    frame.lineId === lineId &&
    frame.atMs === time;
  const invalidate = () => {
    serial.current++;
    setFrame(null);
    setCrop(null);
    setError('');
  };
  const chooseTime = (value: number) => {
    if (!Number.isFinite(value)) return;
    const next = Math.round(Math.max(0, Math.min(maxTime, value)));
    video.current?.pause();
    desired.current = next;
    setTime(next);
    invalidate();
    if (video.current?.readyState) video.current.currentTime = next / 1000;
  };
  const refresh = async () => {
    if (pending.current || busy || saving) return;
    video.current?.pause();
    pending.current = true;
    const request = ++serial.current;
    setWorking(true);
    setError('');
    try {
      const saved = await snapshot();
      if (saved.id !== project.id || saved.media?.path !== project.media?.path)
        throw Error('STALE_REVISION');
      const result = await bridge.previewCharacterPortrait({
        characterId: character.id,
        lineId,
        atMs: desired.current,
        profile,
      });
      if (!alive.current || request !== serial.current) return;
      setFrame(result);
      setRatio(`${result.width} / ${result.height}`);
      setCrop(result.faces.length === 1 ? result.faces[0] : null);
    } catch (e) {
      if (alive.current && request === serial.current)
        setError(String(e).replace(/^Error:\s*/, ''));
    } finally {
      pending.current = false;
      if (alive.current) setWorking(false);
    }
  };
  useEffect(() => {
    let disposed = false;
    void bridge
      .mediaUrl(project)
      .then((value) => {
        if (!disposed) setUrl(value ?? '');
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
    };
    // A preview opens for this project/source; unrelated metadata edits retain playback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, project.media?.path]);
  useEffect(() => {
    alive.current = true;
    const element = video.current;
    const timer = window.setTimeout(() => {
      onAudition();
      void refresh();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      alive.current = false;
      element?.pause();
      element?.removeAttribute('src');
      element?.load();
    };
    // One initial frame per modal opening; seeking uses an explicit refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const point = (clientX: number, clientY: number): Point => {
    const bounds = stage.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (clientY - bounds.top) / bounds.height)),
    };
  };
  const save = async () => {
    if (!current || !portraitRectValid(crop)) return;
    setSaving(true);
    video.current?.pause();
    try {
      await onCapture({ characterId: character.id, lineId, atMs: frame.atMs, crop });
      onClose();
    } catch (e) {
      if (alive.current) setError(String(e).replace(/^Error:\s*/, ''));
    } finally {
      if (alive.current) setSaving(false);
    }
  };
  return (
    <Modal
      className="portrait-modal"
      title={t('portraitPreviewTitle', { name: character.name })}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <div className="portrait-preview-controls">
        <label className="field">
          <span>{t('characterPortraitLine')}</span>
          <select
            aria-label={t('characterPortraitLine')}
            value={lineId}
            disabled={saving}
            onChange={(e) => {
              const line = project.dialogues.find((l) => l.id === e.target.value)!;
              setLine(line.id);
              chooseTime(line.startMs + Math.floor((line.endMs - line.startMs) / 2));
            }}
          >
            {project.dialogues
              .filter((l) => l.characterId === character.id || l.id === initialLineId)
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {formatTime(l.startMs)} → {formatTime(l.endMs)}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>{t('portraitDetectionProfile')}</span>
          <select
            aria-label={t('portraitDetectionProfile')}
            value={profile}
            disabled={saving}
            onChange={(e) => {
              setProfile(e.target.value as typeof profile);
              invalidate();
            }}
          >
            {(['auto', 'anime', 'live'] as const).map((p) => (
              <option key={p} value={p}>
                {t(`portraitProfile.${p}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div
        ref={stage}
        className={`portrait-preview-stage ${current ? 'editable' : ''}`}
        style={{ aspectRatio: ratio }}
      >
        <video
          ref={video}
          src={url || undefined}
          controls
          muted
          playsInline
          preload="metadata"
          aria-label={t('portraitPreviewVideo')}
          style={{ visibility: current ? 'hidden' : 'visible' }}
          onLoadedMetadata={() => {
            const v = video.current!;
            if (!current && v.videoWidth && v.videoHeight)
              setRatio(`${v.videoWidth} / ${v.videoHeight}`);
            v.currentTime = desired.current / 1000;
          }}
          onPlay={() => {
            onAudition();
            setPlaying(true);
            invalidate();
          }}
          onPause={() => setPlaying(false)}
          onTimeUpdate={() => {
            const value = Math.round((video.current?.currentTime ?? 0) * 1000);
            if (Math.abs(value - desired.current) > 1) {
              desired.current = Math.max(0, Math.min(maxTime, value));
              setTime(desired.current);
              invalidate();
            }
          }}
        />
        {current && (
          <>
            <img src={frame.imageUrl} alt={t('portraitPreviewImage')} draggable={false} />
            <div
              className="portrait-preview-overlay"
              aria-label={t('portraitCropArea')}
              role="region"
              onPointerDown={(e) => {
                if (busy || saving || e.button !== 0) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                const kind =
                  (e.target as HTMLElement).dataset.corner ??
                  ((e.target as HTMLElement).dataset.move ? 'move' : 'draw');
                drag.current = { kind, start: point(e.clientX, e.clientY), initial: crop };
              }}
              onPointerMove={(e) => {
                const d = drag.current;
                if (!d || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
                const p = point(e.clientX, e.clientY);
                setCrop(
                  d.kind === 'draw' || !d.initial
                    ? portraitDraw(d.start, p)
                    : d.kind === 'move'
                      ? portraitMove(d.initial, p.x - d.start.x, p.y - d.start.y)
                      : portraitResize(d.initial, d.kind, p),
                );
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
              {frame.faces.map((face, i) => (
                <span
                  className="portrait-face-box"
                  key={i}
                  style={{
                    left: `${face.x * 100}%`,
                    top: `${face.y * 100}%`,
                    width: `${face.width * 100}%`,
                    height: `${face.height * 100}%`,
                  }}
                >
                  {i + 1}
                </span>
              ))}
              {crop && (
                <div
                  className="portrait-crop-box"
                  data-move="true"
                  style={{
                    left: `${crop.x * 100}%`,
                    top: `${crop.y * 100}%`,
                    width: `${crop.width * 100}%`,
                    height: `${crop.height * 100}%`,
                  }}
                >
                  {['nw', 'ne', 'sw', 'se'].map((corner) => (
                    <span
                      key={corner}
                      data-corner={corner}
                      className={`portrait-crop-handle ${corner}`}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      <div className="portrait-preview-transport">
        <button
          className="button subtle"
          aria-label={t(playing ? 'pause' : 'play')}
          disabled={!url || saving}
          onClick={() => {
            const v = video.current;
            if (!v) return;
            if (!v.paused) v.pause();
            else {
              invalidate();
              void v.play().catch((e) => setError(String(e)));
            }
          }}
        >
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <button className="button subtle" disabled={saving} onClick={() => chooseTime(time - 40)}>
          −40 ms
        </button>
        <label>
          <span className="sr-only">{t('portraitPreviewTime')}</span>
          <input
            type="number"
            min="0"
            max={maxTime / 1000}
            step="0.001"
            aria-label={t('portraitPreviewTime')}
            value={time / 1000}
            disabled={saving}
            onChange={(e) => chooseTime(Number(e.target.value) * 1000)}
          />
        </label>
        <button className="button subtle" disabled={saving} onClick={() => chooseTime(time + 40)}>
          +40 ms
        </button>
        <input
          type="range"
          min="0"
          max={maxTime}
          step="1"
          aria-label={t('portraitPreviewSeek')}
          value={time}
          disabled={saving}
          onChange={(e) => chooseTime(Number(e.target.value))}
        />
        <button
          className="button subtle"
          disabled={busy || working || saving || playing}
          onClick={() => void refresh()}
        >
          {working ? <LoaderCircle className="spin" size={15} /> : <ScanFace size={15} />}
          {t('portraitRefreshFaces')}
        </button>
      </div>
      <p className="panel-description">{t('portraitPreviewHint')}</p>
      {current && (
        <>
          <div className="portrait-candidates" role="list" aria-label={t('portraitDetectedFaces')}>
            {frame.faces.map((face, i) => (
              <button
                className="portrait-candidate button subtle"
                aria-pressed={
                  !!crop &&
                  (['x', 'y', 'width', 'height'] as const).every(
                    (key) => Math.abs(crop[key] - face[key]) < 0.000001,
                  )
                }
                key={i}
                disabled={busy || saving}
                onClick={() => setCrop({ ...face })}
                aria-label={t('portraitChooseFace', { number: i + 1 })}
              >
                <svg
                  viewBox={`${face.x * frame.width} ${face.y * frame.height} ${face.width * frame.width} ${face.height * frame.height}`}
                  aria-hidden="true"
                >
                  <image href={frame.imageUrl} width={frame.width} height={frame.height} />
                </svg>
                {t('portraitFaceNumber', { number: i + 1 })}
              </button>
            ))}
            {!frame.faces.length && <p>{t('portraitNoFace')}</p>}
          </div>
          {frame.faces.length > 1 && !crop && <p role="status">{t('portraitChooseAmongFaces')}</p>}
          <div className="portrait-crop-controls">
            <button
              className="button subtle"
              disabled={saving}
              onClick={() => setCrop({ x: 0, y: 0, width: 1, height: 1 })}
            >
              {t('portraitFullFrame')}
            </button>
            {crop &&
              (['x', 'y', 'width', 'height'] as const).map((key) => (
                <label key={key}>
                  {t(`characterCrop.${key}`)} %
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    aria-label={t(`portraitCrop.${key}`)}
                    value={Math.round(crop[key] * 1000) / 10}
                    disabled={saving}
                    onChange={(e) => setCrop({ ...crop, [key]: Number(e.target.value) / 100 })}
                  />
                </label>
              ))}
          </div>
        </>
      )}
      {error && <p role="alert">{t(`errors.${error}`, { defaultValue: error })}</p>}
      {crop && !portraitRectValid(crop) && <p role="alert">{t('portraitCropInvalid')}</p>}
      {!!frame && !current && <p role="status">{t('portraitRefreshRequired')}</p>}
      <div className="dialogue-manage-actions">
        <button className="button subtle" disabled={saving} onClick={onClose}>
          {t('cancel')}
        </button>
        <button
          className="button accent"
          disabled={busy || working || saving || !current || !portraitRectValid(crop)}
          onClick={() => void save()}
        >
          {saving ? <LoaderCircle className="spin" size={15} /> : <ImagePlus size={15} />}
          {t('portraitUseCrop')}
        </button>
      </div>
    </Modal>
  );
}
