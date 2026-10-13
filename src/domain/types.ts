export interface Cue {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
}
export interface MediaStream {
  index: number;
  kind: string;
  codec: string;
  language: string;
  title: string;
  channels: number | null;
  width: number | null;
  height: number | null;
  bitmap: boolean;
}
export interface MediaInfo {
  originalName: string;
  durationMs: number;
  streams: MediaStream[];
}
export interface MediaAsset extends MediaInfo {
  id: string;
  path: string;
  previewPath: string | null;
  audioStreamIndex: number | null;
}
export interface Dialogue {
  id: string;
  startMs: number;
  endMs: number;
  sourceCueIds: string[];
  targetCueIds: string[];
  ttsText: string | null;
  characterId: string | null;
  status: 'ungenerated' | 'generated' | 'review' | 'validated' | 'error';
  warnings: string[];
  selectedGenerationIds: Record<string, string>;
}
export interface Track {
  id: string;
  kind: 'video' | 'original' | 'subtitle' | 'audio';
  role?: 'speech' | 'music' | 'sfx';
  path?: string;
  durationMs?: number;
  sourcePath?: string;
  generationId?: string;
  language: string;
  mute: boolean;
  solo: boolean;
  gain: number;
}
export interface Project {
  formatVersion: number;
  appVersion: string;
  id: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  languages: { source: string; target: string };
  media: MediaAsset | null;
  sourceCues: Cue[];
  targetCues: Cue[];
  dialogues: Dialogue[];
  tracks: Track[];
  characters: unknown[];
  generations: unknown[];
  pronunciation: Record<string, string>;
}
export interface Job {
  id: string;
  projectId: string;
  kind: string;
  status: 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  progress: number | null;
  stage: string;
  error: string | null;
  logs: string[];
}
export interface EnvironmentInfo {
  platform: string;
  ffmpeg: boolean;
  ffprobe: boolean;
}
