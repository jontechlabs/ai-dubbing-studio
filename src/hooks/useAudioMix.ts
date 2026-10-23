import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Project } from '../domain/types';
import { audioTracks, effectiveGain, regionGain } from '../domain/audio';
import { audioUrls } from '../services/bridge';
import { trackPatches, layerGate, layerChanges } from '../domain/audioPatch';
import { AudioPatchBus } from '../services/audioPatchBus';
import { DubbingBus } from '../services/dubbingBus';
import { AudioLevelStore, AudioMeterRouter } from '../services/audioLevels';

type Node = {
  gain: GainNode;
  audio: HTMLMediaElement;
  source: MediaElementAudioSourceNode;
  outputId: string;
};
type Graph = {
  context: AudioContext;
  nodes: Map<string, Node>;
  released: boolean;
  sync: () => void;
  schedule: () => void;
  dubbing: DubbingBus;
  patches: AudioPatchBus;
  meters: AudioMeterRouter;
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
  const [audioLevels] = useState(() => new AudioLevelStore());
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
    active.meters.configure(tracks.map((t) => t.id));
    active.meters.monitor.gain.setValueAtTime(state.volume, active.context.currentTime);
    for (const [id, node] of active.nodes) {
      const track = tracks.find(
        (track) => (track.kind === 'original' ? 'original' : track.id) === id,
      );
      const gain = track ? effectiveGain(track, tracks, 1) : 0;
      if (track && node.outputId !== track.id) {
        node.gain.disconnect();
        node.gain.connect(active.meters.output(track.id));
        node.outputId = track.id;
      }
      // The embedded soundtrack must also be cut at the media element itself.
      node.audio.muted = gain === 0;
    }
    active.schedule();
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
          const meters = new AudioMeterRouter(context, audioLevels);
          const outputId = current.current.project
            ? audioTracks(current.current.project)[0].id
            : 'original';
          source.connect(gain).connect(meters.output(outputId));
          active = {
            context,
            nodes: new Map([['original', { gain, audio: video, source, outputId }]]),
            released: false,
            sync: () => {},
            schedule: () => {},
            dubbing: new DubbingBus(context, onError, (id) => meters.output(id)),
            patches: new AudioPatchBus(context, onError, (id) => meters.output(id)),
            meters,
          };
          graphs.set(video, active);
        } catch (error) {
          void context.close();
          throw error;
        }
      }
    } catch {
      setInitialized(null);
      onError('AUDIO_PLAYBACK_FAILED');
      return;
    }
    active.released = false;
    const attached = active;
    attached.meters.playing(false);
    audioLevels.reset();
    graph.current = attached;
    video.volume = 1;
    attached.schedule = () => {
      const state = current.current,
        tracks = state.project ? audioTracks(state.project) : [];
      const now = attached.context.currentTime,
        position = video.currentTime * 1000;
      for (const [id, node] of attached.nodes) {
        const track = tracks.find(
          (track) => (track.kind === 'original' ? 'original' : track.id) === id,
        );
        const base = track ? effectiveGain(track, tracks, 1) : 0;
        const patches = state.project && track ? trackPatches(state.project, track.id) : [];
        node.gain.gain.cancelScheduledValues(now);
        node.gain.gain.setValueAtTime(
          base * (track ? regionGain(track, position) : 1) * layerGate(patches, position),
          now,
        );
        if (
          track &&
          !video.paused &&
          !video.seeking &&
          video.readyState >= 3 &&
          video.playbackRate > 0
        ) {
          for (const point of layerChanges(
            track,
            patches,
            position,
            position + 3000 * video.playbackRate,
          ))
            node.gain.gain.setValueAtTime(
              base * point.gain,
              now + (point.timeMs - position) / 1000 / video.playbackRate,
            );
        }
      }
    };
    const resume = () => {
      void attached.context
        .resume()
        .then(() => attached.schedule())
        .catch(() => onError('AUDIO_PLAYBACK_FAILED'));
    };
    attached.sync = () => {
      attached.meters.playing(
        !video.paused &&
          !video.seeking &&
          video.readyState >= 3 &&
          attached.context.state === 'running',
      );
      attached.patches.tick(current.current.project, video, 1);
      attached.dubbing.tick(current.current.project, video, 1);
      for (const [id, node] of attached.nodes) {
        if (node.audio === video) continue;
        if (node.audio.muted || video.paused || video.seeking || video.readyState < 3) {
          node.audio.pause();
          continue;
        }
        if (Math.abs(node.audio.currentTime - video.currentTime) > 0.08)
          node.audio.currentTime = video.currentTime;
        node.audio.playbackRate = video.playbackRate;
        if (node.audio.paused)
          void node.audio.play().catch((error: unknown) => {
            // Seeking, pausing and replacing a source can cancel a pending play.
            if (
              !(error instanceof DOMException && error.name === 'AbortError') &&
              !attached.released &&
              graph.current === attached &&
              attached.nodes.get(id) === node &&
              !video.paused &&
              !video.seeking &&
              !node.audio.muted
            )
              onError('AUDIO_PLAYBACK_FAILED');
          });
      }
    };
    const play = () => {
      resume();
      attached.sync();
    };
    const reschedule = () => {
      attached.schedule();
      attached.sync();
    };
    for (const event of ['pause', 'seeking', 'seeked', 'ratechange', 'ended', 'waiting', 'playing'])
      video.addEventListener(event, reschedule);
    video.addEventListener('play', play);
    document.addEventListener('pointerdown', resume, true);
    document.addEventListener('keydown', resume, true);
    const timer = setInterval(reschedule, 100);
    applyRef.current(attached);
    setInitialized(key);
    return () => {
      clearInterval(timer);
      document.removeEventListener('pointerdown', resume, true);
      document.removeEventListener('keydown', resume, true);
      for (const event of [
        'pause',
        'seeking',
        'seeked',
        'ratechange',
        'ended',
        'waiting',
        'playing',
      ])
        video.removeEventListener(event, reschedule);
      video.removeEventListener('play', play);
      video.pause();
      video.muted = true;
      for (const [id, node] of attached.nodes) {
        node.gain.gain.cancelScheduledValues(attached.context.currentTime);
        node.gain.gain.setValueAtTime(0, attached.context.currentTime);
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
          attached.dubbing.dispose();
          attached.patches.dispose();
          attached.meters.dispose();
          graphs.delete(video);
          void attached.context.close();
        }
      });
    };
  }, [key, url, videoRef, onError, audioLevels]);

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
            source.connect(gain).connect(active.meters.output(id));
            audio.src = src;
            active.nodes.set(id, { audio, gain, source, outputId: id });
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
    audioLevels,
    prepare: async (time: number) => {
      if (graph.current) {
        await graph.current.context.resume();
        await Promise.all([
          graph.current.dubbing.prepare(current.current.project, time, 1),
          graph.current.patches.prepare(current.current.project, time, 1),
        ]);
      }
    },
    originalMuted:
      !key || initialized !== key || !tracks[0] || effectiveGain(tracks[0], tracks, 1) === 0,
  };
}
