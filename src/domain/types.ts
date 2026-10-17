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
  voiceSettings?: VoiceSettings;
}
export interface VoiceSettings {
  mood?: 'default' | 'angry' | 'happy' | 'sad' | 'calm' | 'surprised' | 'whisper';
  accent?: 'auto' | 'fr-FR' | 'fr-CA' | 'fr-BE' | 'fr-CH';
  variantId?: string | null;
  device: string;
  referenceMode: 'character' | 'current' | 'custom' | 'file';
  referenceTrackId?: string;
  referenceId: string | null;
  mode: 'zeroShot' | 'crossLingual';
  speed: number;
  seed: number;
}
export interface Generation {
  kind: 'tts';
  id: string;
  dialogueId: string;
  providerId: string;
  modelId: string;
  path: string;
  createdAt: string;
  sourcePath: string | null;
  startMs: number;
  endMs: number;
  text: string;
  language: string;
  characterId: string | null;
  durationMs: number;
  sampleRate: number;
  options: VoiceSettings;
  referenceTranscript: string;
  referenceId?: string | null;
  device: string;
  deviceName: string;
  peakVramMb: number;
  compatibilityMode?: boolean;
  expertMemoryMode?: 'mapped' | null;
  inputHash: string;
}
export interface AudioRegion {
  id: string;
  startMs: number;
  endMs: number;
  gain: number;
  mute: boolean;
}
export interface AudioSelection {
  mediaId: string;
  trackId: string;
  startMs: number;
  endMs: number;
  regionId?: string;
}
export interface Track {
  id: string;
  kind: 'video' | 'original' | 'subtitle' | 'audio' | 'dubbing';
  role?: 'speech' | 'music' | 'sfx';
  path?: string;
  durationMs?: number;
  sourcePath?: string;
  generationId?: string;
  language: string;
  mute: boolean;
  solo: boolean;
  gain: number;
  regions?: AudioRegion[];
  regionsEnabled?: boolean;
}
export interface VoiceReference {
  id: string;
  label: string;
  path: string;
  durationMs: number;
  transcript: string;
  sourceDialogueId?: string | null;
}
export interface Character {
  id: string;
  name: string;
  color: string;
  references: VoiceReference[];
  defaultReferenceId: string | null;
}
export interface SpeakerAnalysis {
  id: string;
  sourcePath: string;
  lines: { id: string; startMs: number; endMs: number }[];
  assignments: {
    dialogueId: string;
    speaker: number | null;
    similarity: number | null;
    reason: string;
  }[];
  clusters: {
    speaker: number;
    referencePath: string;
    durationMs: number;
    referenceDialogueId: string;
  }[];
}
export interface Project {
  dubbingTiming?: {
    sourcePath: string;
    offsetsMs: Record<string, Record<string, number>>;
    durationsMs?: Record<string, Record<string, number>>;
  };
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
  characters: Character[];
  voiceReferences?: VoiceReference[];
  speakerAnalysis?: SpeakerAnalysis | null;
  modelPreferences?: {
    ttsProviderId: string | null;
    voiceVariantId?: string | null;
    referenceTrackId?: string;
    dubbingSourceTrackId?: string;
  };
  subtitleDisplay?: 'off' | 'source' | 'target' | 'both';
  generations: (Generation | { id: string; kind?: string; [key: string]: unknown })[];
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
