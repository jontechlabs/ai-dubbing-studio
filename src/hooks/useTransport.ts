import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dialogue, Project } from '../domain/types';
import { loopRange } from '../domain/time';
import { mediaUrl } from '../services/bridge';
import { useAudioMix } from './useAudioMix';

export function useTransport(
  project: Project | null,
  selected: Dialogue | undefined,
  padding: number,
  onError: (message: string) => void,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [resource, setResource] = useState<{ id: string; url: string } | null>(null);
  const [readyId, setReadyId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [buffering, setBuffering] = useState(false);
  const [time, setTime] = useState(0);
  const timeRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const stopAt = useRef<{ start: number; end: number } | null>(null);
  const pendingSeek = useRef(0);
  const mediaId = project?.media?.id;
  const url = resource?.id === mediaId ? (resource?.url ?? null) : null;
  const ready = !!url && readyId === mediaId;
  const failed = !!mediaId && failedId === mediaId;
  const projectRef = useRef(project);
  projectRef.current = project;
  useEffect(() => {
    let disposed = false;
    pendingSeek.current = 0;
    timeRef.current = 0;
    stopAt.current = null;
    setResource(null);
    setReadyId(null);
    setFailedId(null);
    setBuffering(false);
    setPlaying(false);
    setTime(0);
    const p = projectRef.current;
    if (!p?.media) {
      return;
    }
    void mediaUrl(p)
      .then((value) => {
        if (!disposed) {
          if (!value) throw new Error('MEDIA_MISSING');
          setResource({ id: p.media!.id, url: value });
        }
      })
      .catch((e) => {
        if (!disposed) {
          setFailedId(p.media!.id);
          onError(String(e));
        }
      });
    return () => {
      disposed = true;
    };
  }, [mediaId, onError]);
  const seek = useCallback((ms: number) => {
    pendingSeek.current = Math.max(0, Math.min(ms, projectRef.current?.media?.durationMs || ms));
    const video = videoRef.current;
    if (video?.readyState) video.currentTime = pendingSeek.current / 1000;
    timeRef.current = pendingSeek.current;
    setTime(pendingSeek.current);
  }, []);
  const toggle = useCallback(() => {
    const video = videoRef.current;
    if (!video || !url || !ready) return;
    if (video.paused) void video.play().catch((e) => onError(String(e)));
    else video.pause();
  }, [url, ready, onError]);
  const playLine = useCallback(
    (dialogue: Dialogue) => {
      const range = loopRange(
        dialogue.startMs,
        dialogue.endMs,
        project?.media?.durationMs ?? dialogue.endMs,
        padding,
      );
      stopAt.current = range;
      seek(range.start);
      if (videoRef.current) void videoRef.current.play().catch((e) => onError(String(e)));
    },
    [padding, project?.media?.durationMs, seek, onError],
  );
  useEffect(() => {
    let frame = 0;
    let lastUpdate = 0;
    const tick = (stamp: number) => {
      const video = videoRef.current;
      if (video && !video.paused) {
        const ms = video.currentTime * 1000;
        const range =
          stopAt.current ??
          (loop && selected
            ? loopRange(
                selected.startMs,
                selected.endMs,
                project?.media?.durationMs ?? selected.endMs,
                padding,
              )
            : null);
        if (range && ms >= range.end) {
          if (loop) video.currentTime = range.start / 1000;
          else {
            video.pause();
            stopAt.current = null;
          }
        }
        timeRef.current = video.currentTime * 1000;
        if (stamp - lastUpdate > 100) {
          setTime(video.currentTime * 1000);
          lastUpdate = stamp;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [loop, selected, project?.media?.durationMs, padding]);
  useAudioMix(videoRef, project, url, volume, onError);
  return {
    videoRef,
    url,
    ready,
    failed,
    buffering,
    time,
    timeRef,
    playing,
    loop,
    volume,
    seek,
    toggle,
    playLine,
    setLoop,
    setVolume,
    loaded: () => seek(pendingSeek.current),
    onReady: () => {
      if (mediaId) setReadyId(mediaId);
      setBuffering(false);
    },
    onWaiting: () => setBuffering(true),
    onError: () => {
      if (mediaId) setFailedId(mediaId);
      setReadyId(null);
      setBuffering(false);
      setPlaying(false);
      onError('MEDIA_PLAYBACK_FAILED');
    },
    onPlay: () => {
      setPlaying(true);
      setBuffering(false);
    },
    onPause: () => setPlaying(false),
    onTime: () => {
      if (videoRef.current) {
        timeRef.current = videoRef.current.currentTime * 1000;
        setTime(timeRef.current);
      }
    },
  };
}
export type Transport = ReturnType<typeof useTransport>;
