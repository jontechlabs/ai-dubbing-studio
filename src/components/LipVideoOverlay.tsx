import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Project } from '../domain/types';
import { currentLipVideo, lipVideos } from '../domain/inpaint';
import { inpaintUrl } from '../services/bridge';
import { useTranslation } from 'react-i18next';

// The main video remains the clock and audio source. This layer is always muted.
export function LipVideoOverlay({
  project,
  base,
  enabled,
  onError,
}: {
  project: Project | null;
  base: RefObject<HTMLVideoElement | null>;
  enabled: boolean;
  onError?: () => void;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const edits = useMemo(
    () =>
      project && enabled
        ? lipVideos(project).filter((e) => e.enabled && currentLipVideo(project, e))
        : [],
    [project, enabled],
  );
  const [id, setId] = useState<string | null>(null),
    [url, setUrl] = useState<string | null>(null);
  const overlay = useRef<HTMLVideoElement>(null),
    selected = edits.find((e) => e.id === id),
    current = useRef({ edits, selected });
  current.current = { edits, selected };
  useEffect(() => {
    let disposed = false;
    setUrl(null);
    setFailed(false);
    if (id)
      void inpaintUrl(id)
        .then((value) => {
          if (!disposed) setUrl(value);
        })
        .catch(() => {
          if (!disposed) {
            setFailed(true);
            onError?.();
          }
        });
    return () => {
      disposed = true;
    };
  }, [id, onError]);
  useEffect(() => {
    const original = base.current;
    let lastOverlay: HTMLVideoElement | null = null;
    if (!original) return;
    const sync = () => {
      const now = original.currentTime * 1000,
        edit = current.current.edits.find(
          (e) => now >= e.startMs && now < e.startMs + e.durationMs,
        );
      setId((previous) => (previous === (edit?.id ?? null) ? previous : (edit?.id ?? null)));
      const v = overlay.current;
      lastOverlay = v;
      if (!v) return;
      if (!edit || edit.id !== current.current.selected?.id) {
        v.pause();
        v.style.visibility = 'hidden';
        return;
      }
      const local = (now - edit.startMs) / 1000;
      if (Math.abs(v.currentTime - local) > 0.08) v.currentTime = local;
      v.muted = true;
      v.playbackRate = original.playbackRate;
      v.style.visibility =
        v.readyState >= 2 && !v.seeking && Math.abs(v.currentTime - local) < 0.12
          ? 'visible'
          : 'hidden';
      if (original.paused || original.seeking || original.readyState < 3) v.pause();
      else if (v.paused)
        void v.play().catch((error) => {
          if (!(error instanceof DOMException && error.name === 'AbortError')) {
            setFailed(true);
            onError?.();
          }
        });
    };
    const timer = setInterval(sync, 40);
    for (const event of [
      'play',
      'pause',
      'seeking',
      'seeked',
      'timeupdate',
      'ratechange',
      'waiting',
      'playing',
      'ended',
    ])
      original.addEventListener(event, sync);
    sync();
    return () => {
      clearInterval(timer);
      for (const event of [
        'play',
        'pause',
        'seeking',
        'seeked',
        'timeupdate',
        'ratechange',
        'waiting',
        'playing',
        'ended',
      ])
        original.removeEventListener(event, sync);
      lastOverlay?.pause();
    };
  }, [base, project?.media?.id, onError]);
  return (
    <>
      {failed && id && (
        <span className="lip-preview-error" role="alert">
          {t('inpaintPreviewFailed')}
        </span>
      )}
      {id && url && (
        <video
          className="lip-video-overlay"
          aria-label={t('inpaintPreviewLabel')}
          data-edit-id={id}
          ref={overlay}
          key={`${id}|${url}`}
          src={url}
          muted
          playsInline
          preload="auto"
          onError={() => {
            setFailed(true);
            onError?.();
          }}
        />
      )}
    </>
  );
}
