import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dialogue, Project } from '../domain/types';
import { loopRange } from '../domain/time';
import { mediaUrl } from '../services/bridge';

export function useTransport(
  project: Project | null,
  selected: Dialogue | undefined,
  padding: number,
  onError: (message: string) => void,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const stopAt = useRef<{ start: number; end: number } | null>(null);
  const pendingSeek = useRef(0);
  const mediaId = project?.media?.id;
  const projectRef = useRef(project);
  projectRef.current = project;
  useEffect(() => {
    let disposed = false;
    pendingSeek.current = 0;
    stopAt.current = null;
    setUrl(null);
    const p = projectRef.current;
    if (!p?.media) {
      setUrl(null);
      return;
    }
    void mediaUrl(p)
      .then((value) => {
        if (!disposed) {
          setUrl(value);
          setTime(0);
          setPlaying(false);
        }
      })
      .catch((e) => onError(String(e)));
    return () => {
      disposed = true;
    };
  }, [mediaId, onError]);
  const seek = useCallback((ms: number) => {
    pendingSeek.current = Math.max(0, Math.min(ms, projectRef.current?.media?.durationMs || ms));
    const video = videoRef.current;
    if (video?.readyState) video.currentTime = pendingSeek.current / 1000;
    setTime(pendingSeek.current);
  }, []);
  const toggle = useCallback(() => {
    const video = videoRef.current;
    if (!video || !url) return;
    if (video.paused) void video.play().catch((e) => onError(String(e)));
    else video.pause();
  }, [url, onError]);
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
        if (stamp - lastUpdate > 60) {
          setTime(video.currentTime * 1000);
          lastUpdate = stamp;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [loop, selected, project?.media?.durationMs, padding]);
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [volume, url]);
  return {
    videoRef,
    url,
    time,
    playing,
    loop,
    volume,
    seek,
    toggle,
    playLine,
    setLoop,
    setVolume,
    loaded: () => seek(pendingSeek.current),
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onTime: () => {
      if (videoRef.current) setTime(videoRef.current.currentTime * 1000);
    },
  };
}
export type Transport = ReturnType<typeof useTransport>;
