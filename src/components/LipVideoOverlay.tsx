import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { Project } from '../domain/types';
import { currentLipVideo, lipVideos } from '../domain/inpaint';
import { lipPreviewPlan } from '../domain/lipPreview';
import { dubbingClips } from '../domain/mix';
import { inpaintUrl } from '../services/bridge';
import { useTranslation } from 'react-i18next';

function RetouchVideo({
  id,
  active,
  label,
  register,
  sync,
  fail,
}: {
  id: string;
  active: boolean;
  label: string;
  register: (id: string, value: HTMLVideoElement | null) => void;
  sync: () => void;
  fail: (id: string) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const ref = useCallback((value: HTMLVideoElement | null) => register(id, value), [id, register]);
  useEffect(() => {
    let disposed = false;
    void inpaintUrl(id)
      .then((value) => {
        if (!disposed) setUrl(value);
      })
      .catch(() => {
        if (!disposed) fail(id);
      });
    return () => {
      disposed = true;
    };
  }, [id, fail]);
  useLayoutEffect(sync, [active, url, sync]);
  if (!url) return null;
  return (
    <video
      ref={ref}
      className={`lip-video-overlay ${active ? '' : 'lip-video-preload'}`}
      aria-label={active ? label : undefined}
      aria-hidden={!active}
      data-edit-id={id}
      data-preload={!active}
      src={url}
      muted
      playsInline
      preload="auto"
      style={{ visibility: 'hidden' }}
      onLoadedData={sync}
      onCanPlay={sync}
      onSeeked={sync}
      onError={() => fail(id)}
    />
  );
}

// Never replaces, pauses or seeks the main video. At most two muted decoders:
// current dialogue and nearest upcoming sequence. Keyed children retain their
// decoder when switching from standby to active.
export function LipVideoOverlay({
  project,
  base,
  enabled,
  sourceUrl,
  onError,
}: {
  project: Project | null;
  base: RefObject<HTMLVideoElement | null>;
  enabled: boolean;
  sourceUrl?: string | null;
  onError?: () => void;
}) {
  const { t } = useTranslation();
  const edits = useMemo(() => {
    if (!project || !enabled) return [];
    const clips = dubbingClips(project);
    return lipVideos(project)
      .filter((e) => e.enabled && currentLipVideo(project, e, clips))
      .sort((a, b) => a.startMs - b.startMs);
  }, [project, enabled]);
  const byId = useMemo(() => new Map(edits.map((e) => [e.id, e])), [edits]);
  const [schedule, setSchedule] = useState<{ active?: string; next?: string }>({});
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const nodes = useRef(new Map<string, HTMLVideoElement>());
  const current = useRef({ edits, byId, failed });
  current.current = { edits, byId, failed };
  const synchronize = useRef<() => void>(() => {});
  const sync = useCallback(() => synchronize.current(), []);
  const register = useCallback((id: string, value: HTMLVideoElement | null) => {
    const old = nodes.current.get(id);
    if (old && old !== value) {
      old.pause();
      queueMicrotask(() => {
        // React StrictMode can replay refs while a decoder stays connected.
        if (!old.isConnected) {
          old.removeAttribute('src');
          old.load();
        }
      });
    }
    if (value) nodes.current.set(id, value);
    else nodes.current.delete(id);
  }, []);
  const fail = useCallback(
    (id: string) => {
      setFailed((previous) => (previous.has(id) ? previous : new Set([...previous, id])));
      onError?.();
    },
    [onError],
  );
  useEffect(() => {
    const original = base.current;
    if (!original) return;
    const pool = nodes.current;
    let frame = 0,
      disposed = false;
    const update = () => {
      const now = original.currentTime * 1000;
      const plan = lipPreviewPlan(current.current.edits, now);
      const active = plan.active?.id,
        next = plan.next?.id;
      setSchedule((old) => (old.active === active && old.next === next ? old : { active, next }));
      for (const [id, video] of pool) {
        const edit = current.current.byId.get(id);
        video.muted = true;
        if (!edit || id !== active || current.current.failed.has(id)) {
          video.pause();
          video.style.visibility = 'hidden';
          if (id === next && video.readyState >= 1 && video.currentTime > 0.001)
            video.currentTime = 0;
          continue;
        }
        const local = (now - edit.startMs) / 1000;
        if (!video.seeking && video.readyState >= 1 && Math.abs(video.currentTime - local) > 0.08)
          video.currentTime = local;
        if (video.playbackRate !== original.playbackRate)
          video.playbackRate = original.playbackRate;
        const ready =
          video.readyState >= 2 && !video.seeking && Math.abs(video.currentTime - local) < 0.12;
        video.style.visibility = ready ? 'visible' : 'hidden';
        if (original.paused || original.seeking || original.readyState < 3 || !ready) video.pause();
        else if (video.paused)
          void video.play().catch((error) => {
            if (!(error instanceof DOMException && error.name === 'AbortError')) fail(id);
          });
      }
    };
    synchronize.current = update;
    const tick = () => {
      if (disposed) return;
      update();
      frame = original.requestVideoFrameCallback
        ? original.requestVideoFrameCallback(tick)
        : requestAnimationFrame(tick);
    };
    const events = [
      'play',
      'pause',
      'seeking',
      'seeked',
      'timeupdate',
      'ratechange',
      'waiting',
      'playing',
      'ended',
    ];
    for (const event of events) original.addEventListener(event, update);
    tick();
    return () => {
      disposed = true;
      if (original.cancelVideoFrameCallback) original.cancelVideoFrameCallback(frame);
      else cancelAnimationFrame(frame);
      for (const event of events) original.removeEventListener(event, update);
      for (const video of pool.values()) video.pause();
      synchronize.current = () => {};
    };
  }, [base, project?.media?.id, sourceUrl, fail]);
  useEffect(sync, [edits, sync]);
  const ids = [schedule.active, schedule.next].filter((id): id is string => !!id && byId.has(id));
  return (
    <>
      {schedule.active && failed.has(schedule.active) && (
        <span className="lip-preview-error" role="alert">
          {t('inpaintPreviewFailed')}
        </span>
      )}
      {ids.map((id) => (
        <RetouchVideo
          key={id}
          id={id}
          active={id === schedule.active}
          label={t('inpaintPreviewLabel')}
          register={register}
          sync={sync}
          fail={fail}
        />
      ))}
    </>
  );
}
