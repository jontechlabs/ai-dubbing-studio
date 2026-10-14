export type DeviceBackend = 'cpu' | 'cuda' | 'metal' | 'rocm' | 'directml' | 'vulkan';
export interface ProviderCapabilities {
  languages: string[];
  devices: DeviceBackend[];
  platforms: string[];
  voiceCloning: boolean;
  emotion: boolean;
  streaming: boolean;
  requiredVramMb: number | null;
  canCancel: boolean;
  canPause: boolean;
}
export interface ModelInfo {
  id: string;
  providerId: string;
  runtimeId: string;
  revision: string;
  files: { url: string; sha256: string; size: number; path: string }[];
}
export interface TtsRequest {
  generationId: string;
  modelId: string;
  text: string;
  language: string;
  referenceAudio: string | null;
  referenceTranscript: string | null;
  character: { id: string; name: string } | null;
  emotion: string | null;
  speed: number;
  outputPath: string;
  inputHash: string;
}
export interface TtsResult {
  audioPath: string;
  durationMs: number;
  sampleRate: number;
}
export interface TtsProvider {
  id: string;
  name: string;
  capabilities(): ProviderCapabilities;
  generate(request: TtsRequest, signal: AbortSignal): Promise<TtsResult>;
  listModels(): Promise<ModelInfo[]>;
  installModel(modelId: string): Promise<void>;
}
export interface TranscriptionProvider {
  transcribe(audioPath: string, language: string, signal: AbortSignal): Promise<unknown>;
}
export interface SeparationProvider {
  separate(audioPath: string, signal: AbortSignal): Promise<Record<string, string>>;
}
export interface VoiceConversionProvider {
  convert(audioPath: string, referencePath: string, signal: AbortSignal): Promise<TtsResult>;
}
export interface TranslationProvider {
  translate(text: string, source: string, target: string, signal: AbortSignal): Promise<string>;
}
export const futureVoiceProviders = [
  { id: 'cosyvoice3', name: 'CosyVoice3', phase: 5 },
  { id: 'fish-s2', name: 'Fish Audio S2', phase: 6 },
  { id: 'qwen3-tts', name: 'Qwen3-TTS', phase: 6 },
] as const;
export interface SpeakerIdentificationProvider {
  id: string;
  name: string;
  capabilities(): ProviderCapabilities;
  identify(
    request: {
      audioPath: string;
      lines: { id: string; startMs: number; endMs: number }[];
      threshold: number;
    },
    signal: AbortSignal,
  ): Promise<import('./types').SpeakerAnalysis>;
  installModel(modelId: string): Promise<void>;
}
