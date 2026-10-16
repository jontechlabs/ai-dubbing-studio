import type { Project, Track } from '../domain/types';
import {
  audioPatches,
  trackPatches,
  layerGate,
  layerChanges,
  type AudioPatch,
} from '../domain/audioPatch';
import { audioTracks, effectiveGain, regionGain } from '../domain/audio';
import { audioPatchUrl } from './bridge';

// Decode only the nearby takes; schedule them against the video clock, never a UI timer.
export class AudioPatchBus {
  private cache = new Map<string, Promise<AudioBuffer>>();
  private decoded = new Map<string, AudioBuffer>();
  private voices = new Map<string, { source: AudioBufferSourceNode; gain: GainNode }>();
  private anchor: { time: number; position: number; rate: number } | null = null;
  private controller = new AbortController();
  private disposed = false;
  private project: Project | null = null;
  private clips: AudioPatch[] = [];
  private reported = false;
  private signature = '';
  private getClips(project: Project) {
    if (this.project !== project) {
      this.project = project;
      this.clips = audioPatches(project).filter(
        (e) => e.sourcePath === project.media?.path && e.mode !== 'silence',
      );
      const signature = this.clips
        .map((c) => `${c.id}:${c.startMs}:${c.endMs}:${c.gain}`)
        .join('|');
      if (this.signature !== signature) this.stop();
      this.signature = signature;
      this.reported = false;
    }
    return this.clips;
  }
  constructor(
    private context: AudioContext,
    private onError: (error: string) => void,
  ) {}
  private load(clip: AudioPatch) {
    const id = clip.id;
    let promise = this.cache.get(id);
    if (!promise) {
      promise = audioPatchUrl(clip.id)
        .then(async (url) => {
          const response = await fetch(url, { signal: this.controller.signal });
          if (!response.ok) throw Error('AUDIO_PLAYBACK_FAILED');
          const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
          if (!this.disposed && this.cache.get(id) === promise) this.decoded.set(id, buffer);
          return buffer;
        })
        .catch((error: unknown) => {
          if (this.cache.get(id) === promise) this.cache.delete(id);
          throw error;
        });
      this.cache.set(id, promise);
    }
    return promise;
  }
  async prepare(project: Project | null, time: number, volume: number) {
    if (!project || this.disposed) return;
    const tracks = audioTracks(project);
    const nearby = this.getClips(project).filter((c) => {
      const track = tracks.find((t) => t.id === c.trackId);
      return (
        c.endMs > time &&
        c.startMs < time + 3000 &&
        !!track &&
        !!effectiveGain(track, tracks, volume)
      );
    });
    if (
      nearby.length > 8 ||
      nearby.reduce(
        (n, c) => n + (c.endMs - c.startMs) * (this.context.sampleRate / 1000) * 2 * 4,
        0,
      ) >
        128 * 1024 * 1024
    )
      throw Error('AUDIO_TRANSFER_LIMIT');
    const keep = new Set([...nearby.map((c) => c.id), ...this.voices.keys()]);
    for (const id of this.cache.keys()) {
      if (
        this.cache.size + nearby.filter((c) => !this.cache.has(c.id)).length <= 8 &&
        [...this.decoded.entries()].reduce((n, [, b]) => n + b.length * b.numberOfChannels * 4, 0) +
          nearby
            .filter((c) => !this.decoded.has(c.id))
            .reduce(
              (n, c) => n + (c.endMs - c.startMs) * (this.context.sampleRate / 1000) * 2 * 4,
              0,
            ) <=
          128 * 1024 * 1024
      )
        break;
      if (!keep.has(id)) {
        this.cache.delete(id);
        this.decoded.delete(id);
      }
    }
    await Promise.all(nearby.map((c) => this.load(c)));
  }
  stop() {
    for (const voice of this.voices.values()) {
      voice.source.onended = null;
      voice.source.stop();
      voice.source.disconnect();
      voice.gain.disconnect();
    }
    this.voices.clear();
    this.anchor = null;
  }
  tick(project: Project | null, video: HTMLVideoElement, volume: number) {
    const tracks = project ? audioTracks(project) : [];
    if (!project || video.paused || video.seeking || video.readyState < 3) {
      this.stop();
      return;
    }
    const now = this.context.currentTime,
      position = video.currentTime * 1000,
      rate = video.playbackRate;
    if (
      this.anchor &&
      (rate !== this.anchor.rate ||
        Math.abs(position - this.anchor.position - (now - this.anchor.time) * 1000 * rate) > 80)
    )
      this.stop();
    this.anchor ??= { time: now, position, rate };
    const clips = this.getClips(project).filter(
      (c) => c.endMs > position && c.startMs < position + 500 * rate,
    );
    const desired = new Set(clips.map((c) => c.id));
    for (const [id, voice] of this.voices)
      if (!desired.has(id)) {
        voice.source.onended = null;
        voice.source.stop();
        voice.source.disconnect();
        voice.gain.disconnect();
        this.voices.delete(id);
      }
    for (const clip of clips) {
      const track = tracks.find((t) => t.id === clip.trackId);
      if (!track) continue;
      const base = effectiveGain(track, tracks, volume) * clip.gain;
      const id = clip.id,
        buffer = this.decoded.get(id);
      if (!buffer || position >= clip.startMs + buffer.duration * 1000) continue;
      let voice = this.voices.get(id);
      if (!voice) {
        const source = this.context.createBufferSource(),
          gain = this.context.createGain();
        source.buffer = buffer;
        source.playbackRate.value = rate;
        gain.gain.value = 0;
        source.connect(gain).connect(this.context.destination);
        voice = { source, gain };
        this.voices.set(id, voice);
        source.onended = () => {
          source.disconnect();
          gain.disconnect();
          if (this.voices.get(id)?.source === source) this.voices.delete(id);
        };
        const offset = Math.max(0, position - clip.startMs) / 1000;
        const length = Math.min(buffer.duration, (clip.endMs - clip.startMs) / 1000) - offset;
        if (length > 0)
          source.start(now + Math.max(0, clip.startMs - position) / 1000 / rate, offset, length);
      }
      this.gains(
        voice.gain,
        track,
        trackPatches(project, track.id),
        clip.id,
        base,
        position,
        clip.endMs,
        rate,
        now,
      );
    }
    void this.prepare(project, position, volume).catch(() => {
      if (!this.disposed && !this.reported) {
        this.reported = true;
        this.onError('AUDIO_PLAYBACK_FAILED');
      }
    });
  }
  private gains(
    node: GainNode,
    track: Track,
    patches: AudioPatch[],
    id: string,
    base: number,
    position: number,
    end: number,
    rate: number,
    now: number,
  ) {
    const index = patches.findIndex((p) => p.id === id);
    node.gain.cancelScheduledValues(now);
    node.gain.setValueAtTime(
      base * regionGain(track, position) * layerGate(patches, position, index),
      now,
    );
    for (const point of layerChanges(track, patches, position, end, index))
      node.gain.setValueAtTime(base * point.gain, now + (point.timeMs - position) / 1000 / rate);
  }
  dispose() {
    this.disposed = true;
    this.controller.abort();
    this.stop();
    this.cache.clear();
    this.decoded.clear();
  }
}
