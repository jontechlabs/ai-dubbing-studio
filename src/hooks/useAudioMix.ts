import { useEffect, useRef, type RefObject } from 'react';
import type { Project } from '../domain/types';
import { audioTracks, effectiveGain } from '../domain/audio';
import { audioUrls } from '../services/bridge';

export function useAudioMix(
  videoRef: RefObject<HTMLVideoElement | null>,
  project: Project | null,
  url: string | null,
  volume: number,
  onError: (message: string) => void,
) {
  const graph = useRef<{
    context: AudioContext;
    nodes: Map<string, { gain: GainNode; audio: HTMLMediaElement }>;
  } | null>(null);
  const current = useRef({ project, volume });
  current.current = { project, volume };
  const files =
    project?.tracks
      .filter((track) => track.kind === 'audio')
      .map((track) => `${track.id}:${track.path}`)
      .join('|') ?? '';
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url) return;
    const context = new AudioContext();
    const nodes = new Map<string, { gain: GainNode; audio: HTMLMediaElement }>();
    const gain = context.createGain();
    context.createMediaElementSource(video).connect(gain).connect(context.destination);
    video.volume = 1;
    nodes.set('original', { gain, audio: video });
    graph.current = { context, nodes };
    const apply = () => {
      const state = current.current;
      if (!state.project) return;
      const tracks = audioTracks(state.project);
      for (const track of tracks) {
        const node = nodes.get(track.kind === 'original' ? 'original' : track.id);
        if (node) node.gain.gain.value = effectiveGain(track, tracks, state.volume);
      }
    };
    apply();
    const resume = () => {
      void context.resume().catch(() => undefined);
    };
    const sync = () => {
      for (const node of nodes.values()) {
        if (node.audio === video) continue;
        if (node.gain.gain.value === 0) {
          node.audio.pause();
          continue;
        }
        if (Math.abs(node.audio.currentTime - video.currentTime) > 0.08)
          node.audio.currentTime = video.currentTime;
        node.audio.playbackRate = video.playbackRate;
        if (video.paused) node.audio.pause();
        else if (node.audio.paused)
          void node.audio.play().catch(() => onError('AUDIO_PLAYBACK_FAILED'));
      }
    };
    const play = () => {
      resume();
      sync();
    };
    video.addEventListener('play', play);
    video.addEventListener('pause', sync);
    video.addEventListener('seeking', sync);
    video.addEventListener('ratechange', sync);
    document.addEventListener('pointerdown', resume, true);
    document.addEventListener('keydown', resume, true);
    const timer = setInterval(sync, 200);
    return () => {
      clearInterval(timer);
      document.removeEventListener('pointerdown', resume, true);
      document.removeEventListener('keydown', resume, true);
      video.removeEventListener('play', play);
      video.removeEventListener('pause', sync);
      video.removeEventListener('seeking', sync);
      video.removeEventListener('ratechange', sync);
      for (const node of nodes.values()) {
        if (node.audio !== video) {
          node.audio.pause();
          node.audio.removeAttribute('src');
          node.audio.load();
        }
        node.gain.disconnect();
      }
      graph.current = null;
      void context.close();
    };
  }, [url, videoRef, onError]);
  useEffect(() => {
    const active = graph.current,
      p = current.current.project;
    if (!active || !p) return;
    let disposed = false;
    void audioUrls(p)
      .then((urls) => {
        if (disposed || graph.current !== active) return;
        const desired = new Set(
          audioTracks(p)
            .filter((track) => track.kind === 'audio')
            .map((track) => track.id),
        );
        for (const [id, node] of active.nodes)
          if (id !== 'original' && !desired.has(id)) {
            node.audio.pause();
            node.audio.removeAttribute('src');
            node.gain.disconnect();
            active.nodes.delete(id);
          }
        for (const [id, src] of Object.entries(urls))
          if (desired.has(id) && !active.nodes.has(id)) {
            const audio = new Audio();
            audio.crossOrigin = 'anonymous';
            audio.preload = 'auto';
            audio.src = src;
            audio.currentTime = videoRef.current?.currentTime ?? 0;
            const gain = active.context.createGain();
            gain.gain.value = 0;
            active.context
              .createMediaElementSource(audio)
              .connect(gain)
              .connect(active.context.destination);
            active.nodes.set(id, { audio, gain });
            audio.addEventListener('error', () => onError('AUDIO_PLAYBACK_FAILED'));
          }
        const tracks = audioTracks(current.current.project!);
        for (const track of tracks) {
          const node = active.nodes.get(track.kind === 'original' ? 'original' : track.id);
          if (node) node.gain.gain.value = effectiveGain(track, tracks, current.current.volume);
        }
      })
      .catch(() => {
        if (!disposed) onError('AUDIO_PLAYBACK_FAILED');
      });
    return () => {
      disposed = true;
    };
  }, [files, url, videoRef, onError]);
  useEffect(() => {
    const active = graph.current;
    if (!active || !project) return;
    const tracks = audioTracks(project);
    for (const track of tracks) {
      const node = active.nodes.get(track.kind === 'original' ? 'original' : track.id);
      if (node) node.gain.gain.value = effectiveGain(track, tracks, volume);
    }
  }, [project?.tracks, project, volume]);
}
