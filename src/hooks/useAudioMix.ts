import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Project } from '../domain/types';
import { audioTracks, effectiveGain } from '../domain/audio';
import { audioUrls } from '../services/bridge';

type Node = { gain: GainNode; audio: HTMLMediaElement; source: MediaElementAudioSourceNode };
type Graph = {
  context: AudioContext;
  nodes: Map<string, Node>;
  released: boolean;
  sync: () => void;
};
// One source node per media element, including React's effect replay.
const graphs = new WeakMap<HTMLVideoElement, Graph>();

export function useAudioMix(
  videoRef: RefObject<HTMLVideoElement | null>,
  project: Project | null,
  url: string | null,
  volume: number,
  onError: (message: string) => void,
) {
  const graph = useRef<Graph | null>(null);
  const current = useRef({ project, volume });
  current.current = { project, volume };
  const [initialized, setInitialized] = useState<string | null>(null);
  const key = url ? `${project?.media?.id}|${url}` : null;
  const files = (project ? audioTracks(project) : [])
    .filter((track) => track.kind === 'audio')
    .map((track) => `${track.id}:${track.path}`)
    .join('|');

  const apply = (active: Graph) => {
    const state = current.current;
    const tracks = state.project ? audioTracks(state.project) : [];
    for (const [id, node] of active.nodes) {
      const track = tracks.find(
        (track) => (track.kind === 'original' ? 'original' : track.id) === id,
      );
      const gain = track ? effectiveGain(track, tracks, state.volume) : 0;
      node.gain.gain.value = gain;
      // The embedded soundtrack must also be cut at the media element itself.
      node.audio.muted = gain === 0;
    }
    active.sync();
  };
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useLayoutEffect(() => {
    const video = videoRef.current;
    if (!video || !url || !key) return;
    video.muted = true;
    let active = graphs.get(video);
    try {
      if (!active) {
        const context = new AudioContext();
        try {
          const gain = context.createGain();
          gain.gain.value = 0;
          const source = context.createMediaElementSource(video);
          source.connect(gain).connect(context.destination);
          active = {
            context,
            nodes: new Map([['original', { gain, audio: video, source }]]),
            released: false,
            sync: () => {},
          };
          graphs.set(video, active);
        } catch (error) {
          void context.close();
          throw error;
        }
      }
    } catch {
      onError('AUDIO_PLAYBACK_FAILED');
      return;
    }
    active.released = false;
    const attached = active;
    graph.current = attached;
    video.volume = 1;
    const resume = () => {
      void attached.context.resume().catch(() => onError('AUDIO_PLAYBACK_FAILED'));
    };
    attached.sync = () => {
      for (const node of attached.nodes.values()) {
        if (node.audio === video) continue;
        if (node.audio.muted || video.paused) {
          node.audio.pause();
          continue;
        }
        if (Math.abs(node.audio.currentTime - video.currentTime) > 0.08)
          node.audio.currentTime = video.currentTime;
        node.audio.playbackRate = video.playbackRate;
        if (node.audio.paused) void node.audio.play().catch(() => onError('AUDIO_PLAYBACK_FAILED'));
      }
    };
    const play = () => {
      resume();
      attached.sync();
    };
    for (const event of ['pause', 'seeking', 'ratechange', 'ended'])
      video.addEventListener(event, attached.sync);
    video.addEventListener('play', play);
    document.addEventListener('pointerdown', resume, true);
    document.addEventListener('keydown', resume, true);
    const timer = setInterval(attached.sync, 200);
    applyRef.current(attached);
    setInitialized(key);
    return () => {
      clearInterval(timer);
      document.removeEventListener('pointerdown', resume, true);
      document.removeEventListener('keydown', resume, true);
      for (const event of ['pause', 'seeking', 'ratechange', 'ended'])
        video.removeEventListener(event, attached.sync);
      video.removeEventListener('play', play);
      video.pause();
      video.muted = true;
      for (const [id, node] of attached.nodes) {
        node.gain.gain.value = 0;
        if (id !== 'original') {
          node.audio.pause();
          node.audio.removeAttribute('src');
          node.audio.load();
          node.source.disconnect();
          node.gain.disconnect();
          attached.nodes.delete(id);
        }
      }
      graph.current = null;
      attached.released = true;
      queueMicrotask(() => {
        if (attached.released) {
          graphs.delete(video);
          void attached.context.close();
        }
      });
    };
  }, [key, url, videoRef, onError]);

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
          if (
            id !== 'original' &&
            (!desired.has(id) ||
              !urls[id] ||
              node.audio.src !== new URL(urls[id], document.baseURI).href)
          ) {
            node.audio.pause();
            node.audio.removeAttribute('src');
            node.audio.load();
            node.source.disconnect();
            node.gain.disconnect();
            active.nodes.delete(id);
          }
        for (const [id, src] of Object.entries(urls))
          if (desired.has(id) && !active.nodes.has(id)) {
            const audio = new Audio();
            audio.crossOrigin = 'anonymous';
            audio.preload = 'auto';
            audio.muted = true;
            const gain = active.context.createGain();
            gain.gain.value = 0;
            const source = active.context.createMediaElementSource(audio);
            source.connect(gain).connect(active.context.destination);
            audio.src = src;
            active.nodes.set(id, { audio, gain, source });
            audio.addEventListener('error', () => onError('AUDIO_PLAYBACK_FAILED'));
          }
        applyRef.current(active);
      })
      .catch(() => {
        if (!disposed) onError('AUDIO_PLAYBACK_FAILED');
      });
    return () => {
      disposed = true;
    };
  }, [files, key, videoRef, onError]);

  useLayoutEffect(() => {
    if (graph.current) applyRef.current(graph.current);
  }, [project, volume]);
  const tracks = project ? audioTracks(project) : [];
  return {
    originalMuted:
      !key || initialized !== key || !tracks[0] || effectiveGain(tracks[0], tracks, volume) === 0,
  };
}
