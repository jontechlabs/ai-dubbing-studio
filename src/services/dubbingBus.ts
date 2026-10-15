import type { Project, Track } from '../domain/types';
import { dubbingClips } from '../domain/mix';
import { audioTracks, effectiveGain, gainChanges, regionGain } from '../domain/audio';
import { generationUrl } from './bridge';

// Decode only the nearby takes; schedule them against the video clock, never a UI timer.
export class DubbingBus {
  private cache = new Map<string, Promise<AudioBuffer>>();
  private decoded = new Map<string, AudioBuffer>();
  private voices = new Map<string, { source: AudioBufferSourceNode; gain: GainNode }>();
  private anchor: { time: number; position: number; rate: number } | null = null;
  private controller = new AbortController();
  private disposed = false;
  private project: Project | null = null;
  private clips: ReturnType<typeof dubbingClips> = [];
  private reported = false;
  private signature = '';
  private getClips(project: Project) {
    if (this.project !== project) {
      this.project = project;
      this.clips = dubbingClips(project);
      const signature = this.clips
        .map((c) => `${c.generation.id}:${c.startMs}:${c.endMs}`)
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
  private load(id: string) {
    let promise = this.cache.get(id);
    if (!promise) {
      promise = generationUrl(id).then(async (url) => {
        const response = await fetch(url, { signal: this.controller.signal });
        if (!response.ok) throw Error('AUDIO_PLAYBACK_FAILED');
        const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
        if (!this.disposed && this.cache.get(id) === promise) this.decoded.set(id, buffer);
        return buffer;
      });
      this.cache.set(id, promise);
    }
    return promise;
  }
  async prepare(project: Project | null, time: number, volume: number) {
    if (!project || this.disposed) return;
    const tracks = audioTracks(project),
      track = tracks.find((t) => t.kind === 'dubbing');
    if (!track || !effectiveGain(track, tracks, volume)) return;
    const nearby = this.getClips(project).filter((c) => c.endMs > time && c.startMs < time + 3000);
    const keep = new Set([...nearby.map((c) => c.generation.id), ...this.voices.keys()]);
    for (const id of this.cache.keys()) {
      if (this.cache.size <= 24) break;
      if (!keep.has(id)) {
        this.cache.delete(id);
        this.decoded.delete(id);
      }
    }
    await Promise.all(nearby.map((c) => this.load(c.generation.id)));
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
    const track = tracks.find((t) => t.kind === 'dubbing');
    const base = track ? effectiveGain(track, tracks, volume) : 0;
    if (!project || !track || !base || video.paused || video.seeking || video.readyState < 3) {
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
    const desired = new Set(clips.map((c) => c.generation.id));
    for (const [id, voice] of this.voices)
      if (!desired.has(id)) {
        voice.source.onended = null;
        voice.source.stop();
        voice.source.disconnect();
        voice.gain.disconnect();
        this.voices.delete(id);
      }
    for (const clip of clips) {
      const id = clip.generation.id,
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
      this.gains(voice.gain, track, base, position, clip.endMs, rate, now);
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
    base: number,
    position: number,
    end: number,
    rate: number,
    now: number,
  ) {
    node.gain.cancelScheduledValues(now);
    node.gain.setValueAtTime(base * regionGain(track, position), now);
    for (const point of gainChanges(track, position, end))
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
