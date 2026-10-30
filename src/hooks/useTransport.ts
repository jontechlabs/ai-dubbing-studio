import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AudioSelection, Dialogue, Project } from '../domain/types';
import { loopRange } from '../domain/time';
import { mediaUrl } from '../services/bridge';
import { useAudioMix } from './useAudioMix';
import { audioTracks } from '../domain/audio';
import { audioSelectionProject, validAudioSelection } from '../domain/audioAudition';

export function useTransport(
  project: Project | null,
  selected: Dialogue | undefined,
  padding: number,
  onError: (message: string) => void,
  selection: AudioSelection | null = null,
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
  const [originalOnly, setOriginalOnly] = useState(false);
  const [selectionAudition, setSelectionAudition] = useState<{
    projectId: string;
    selection: AudioSelection;
    beforeLevels: boolean;
  } | null>(null);
  const selectionAuditionRef = useRef(selectionAudition);
  selectionAuditionRef.current = selectionAudition;
  const playToken = useRef(0);
  const [preparingDub, setPreparingDub] = useState(false);
  const stopAt = useRef<{ start: number; end: number } | null>(null);
  const pendingSeek = useRef(0);
  const mediaId = project?.media?.id;
  const mixerKey = useMemo(() => JSON.stringify(project ? audioTracks(project) : []), [project]);
  useEffect(() => setOriginalOnly(false), [mixerKey]);
  const url = resource?.id === mediaId ? (resource?.url ?? null) : null;
  const ready = !!url && readyId === mediaId;
  const failed = !!mediaId && failedId === mediaId;
  const projectRef = useRef(project);
  projectRef.current = project;
  const stopAudioSelection = useCallback(() => {
    if (!selectionAuditionRef.current) return;
    selectionAuditionRef.current = null;
    ++playToken.current;
    setPreparingDub(false);
    videoRef.current?.pause();
    stopAt.current = null;
    setSelectionAudition(null);
  }, []);
  useEffect(() => {
    document.addEventListener('studio-voice-preview', stopAudioSelection);
    return () => document.removeEventListener('studio-voice-preview', stopAudioSelection);
  }, [stopAudioSelection]);
  const selectionScope = JSON.stringify([
    project?.id,
    selection?.mediaId,
    selection?.trackId,
    selection?.startMs,
    selection?.endMs,
  ]);
  useEffect(() => {
    const active = selectionAuditionRef.current;
    if (
      active &&
      JSON.stringify([
        active.projectId,
        active.selection.mediaId,
        active.selection.trackId,
        active.selection.startMs,
        active.selection.endMs,
      ]) !== selectionScope
    )
      stopAudioSelection();
  }, [selectionScope, stopAudioSelection]);
  useEffect(() => {
    let disposed = false;
    ++playToken.current;
    setPreparingDub(false);
    pendingSeek.current = 0;
    timeRef.current = 0;
    stopAt.current = null;
    setResource(null);
    setOriginalOnly(false);
    selectionAuditionRef.current = null;
    setSelectionAudition(null);
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
  const seek = useCallback(
    (ms: number) => {
      stopAudioSelection();
      ++playToken.current;
      setPreparingDub(false);
      pendingSeek.current = Math.max(0, Math.min(ms, projectRef.current?.media?.durationMs || ms));
      const video = videoRef.current;
      if (video?.readyState) video.currentTime = pendingSeek.current / 1000;
      timeRef.current = pendingSeek.current;
      setTime(pendingSeek.current);
    },
    [stopAudioSelection],
  );
  const monitoredProject = useMemo(() => {
    if (selectionAudition && project && validAudioSelection(project, selectionAudition.selection))
      return audioSelectionProject(
        project,
        selectionAudition.selection,
        selectionAudition.beforeLevels,
      );
    if (!originalOnly || !project) return project;
    return {
      ...project,
      generations: project.generations.filter((g) => g.kind !== 'audioPatch'),
      tracks: [
        ...project.tracks
          .filter((t) => t.kind !== 'original')
          .map((t) => ({ ...t, mute: true, solo: false })),
        { ...audioTracks(project)[0], mute: false, solo: true, gain: 1, regionsEnabled: false },
      ],
    };
  }, [originalOnly, project, selectionAudition]);
  const mix = useAudioMix(videoRef, monitoredProject, url, volume, onError);
  const prepareRef = useRef(mix.prepare);
  prepareRef.current = mix.prepare;
  const startVideo = useCallback(async () => {
    const token = ++playToken.current,
      video = videoRef.current;
    if (!video) return;
    setPreparingDub(true);
    try {
      await prepareRef.current(video.currentTime * 1000);
      if (token === playToken.current && video === videoRef.current) await video.play();
    } catch (error) {
      if (token === playToken.current) {
        stopAudioSelection();
        onError(String(error));
      }
    } finally {
      if (token === playToken.current) setPreparingDub(false);
    }
  }, [onError, stopAudioSelection]);
  const queueStart = useCallback(() => {
    const token = ++playToken.current;
    let started = false;
    let frame = 0;
    const begin = () => {
      if (started) return;
      started = true;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      if (token === playToken.current) void startVideo();
    };
    frame = requestAnimationFrame(begin);
    // A minimized/hidden WebView may suspend animation frames. Keep commands
    // usable after React has committed its mixer changes in that case too.
    const timer = setTimeout(begin, 80);
  }, [startVideo]);
  const toggle = useCallback(() => {
    if (selectionAuditionRef.current) {
      stopAudioSelection();
      return;
    }
    setOriginalOnly(false);
    const video = videoRef.current;
    if (!video || !url || !ready) return;
    if (preparingDub) {
      ++playToken.current;
      setPreparingDub(false);
    } else if (video.paused) queueStart();
    else video.pause();
  }, [url, ready, preparingDub, queueStart, stopAudioSelection]);
  const playAudioSelection = useCallback(
    (range: AudioSelection, beforeLevels = false) => {
      if (!validAudioSelection(projectRef.current, range)) throw Error('INVALID_AUDIO_REGION');
      if (!ready || !videoRef.current) throw Error('MEDIA_LOADING');
      stopAudioSelection();
      videoRef.current.pause();
      setOriginalOnly(false);
      seek(range.startMs);
      stopAt.current = { start: range.startMs, end: range.endMs };
      const audition = { projectId: projectRef.current!.id, selection: { ...range }, beforeLevels };
      selectionAuditionRef.current = audition;
      setSelectionAudition(audition);
      queueStart();
    },
    [ready, stopAudioSelection, seek, queueStart],
  );
  useEffect(() => {
    if (!selectionAudition) return;
    const video = videoRef.current;
    const finish = () => {
      const active = selectionAuditionRef.current;
      if (video && active && (video.ended || video.currentTime * 1000 >= active.selection.endMs)) {
        const end = active.selection.endMs;
        stopAudioSelection();
        video.currentTime = end / 1000;
      }
    };
    // Also bound playback when a hidden WebView suspends animation frames.
    const timer = setInterval(finish, 40);
    video?.addEventListener('timeupdate', finish);
    video?.addEventListener('ended', finish);
    return () => {
      clearInterval(timer);
      video?.removeEventListener('timeupdate', finish);
      video?.removeEventListener('ended', finish);
    };
  }, [selectionAudition, stopAudioSelection]);
  const playLine = useCallback(
    (dialogue: Dialogue) => {
      stopAudioSelection();
      setOriginalOnly(false);
      const range = loopRange(
        dialogue.startMs,
        dialogue.endMs,
        project?.media?.durationMs ?? dialogue.endMs,
        padding,
      );
      stopAt.current = range;
      seek(range.start);
      if (videoRef.current) queueStart();
    },
    [padding, project?.media?.durationMs, seek, queueStart, stopAudioSelection],
  );
  const playOriginalLine = useCallback(
    (dialogue?: Dialogue) => {
      stopAudioSelection();
      setOriginalOnly(true);
      stopAt.current = dialogue
        ? loopRange(
            dialogue.startMs,
            dialogue.endMs,
            project?.media?.durationMs ?? dialogue.endMs,
            padding,
          )
        : null;
      if (stopAt.current) seek(stopAt.current.start);
      queueStart();
    },
    [padding, project?.media?.durationMs, seek, queueStart, stopAudioSelection],
  );
  const endOriginal = useCallback(() => {
    stopAudioSelection();
    setOriginalOnly(false);
  }, [stopAudioSelection]);
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
          if (loop && !selectionAuditionRef.current) video.currentTime = range.start / 1000;
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
  return {
    ...mix,
    videoRef,
    url,
    ready,
    failed,
    buffering: buffering || preparingDub,
    time,
    timeRef,
    playing,
    loop,
    volume,
    seek,
    toggle,
    playLine,
    playOriginalLine,
    playAudioSelection,
    stopAudioSelection,
    selectionAudition,
    originalOnly,
    endOriginal,
    pause: () => {
      stopAudioSelection();
      ++playToken.current;
      setPreparingDub(false);
      videoRef.current?.pause();
    },
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
