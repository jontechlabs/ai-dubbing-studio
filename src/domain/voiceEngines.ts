import { moodFormatVersion } from './voiceMoods';
export const installedVoiceVariants = [
  { id: 'cosy3-official', providerId: 'cosyvoice3', name: 'CosyVoice3 0.5B RL', backend: 'cuda' },
  {
    id: 'qwen3-06b-gguf-q8',
    providerId: 'qwen3-tts',
    name: 'Qwen3-TTS Base 0.6B · GGUF Q8_0',
    backend: 'vulkan',
  },
  {
    id: 'qwen3-17b-gguf-q8',
    providerId: 'qwen3-tts',
    name: 'Qwen3-TTS Base 1.7B · GGUF Q8_0',
    backend: 'vulkan',
  },
  {
    id: 'fish-s2-gguf-q8',
    providerId: 'fish-s2',
    name: 'Fish S2 Pro · GGUF Q8_0',
    backend: 'vulkan',
  },
  { id: 'fish-s2-fp8', providerId: 'fish-s2', name: 'Fish S2 Pro · FP8 E4M3', backend: 'cuda' },
  {
    id: 'drama3-comfy-fp8',
    providerId: 'fish-drama3',
    name: 'Fish Audio Drama 3 · FP8 · experts en RAM',
    backend: 'cuda',
  },
  { id: 'voxcpm2-bf16', providerId: 'voxcpm2', name: 'VoxCPM2 · 2B · BF16', backend: 'cuda' },
  {
    id: 'chatterbox-multilingual-v3',
    providerId: 'chatterbox',
    name: 'Chatterbox Multilingual V3 · 500M',
    backend: 'cuda',
  },
] as const;
export function multilingualVariant(id?: string | null) {
  return id === 'voxcpm2-bf16' || id === 'chatterbox-multilingual-v3';
}
export function voiceSettingsFormat(settings: {
  outputGain?: number;
  variantId?: string | null;
  mood?: import('./voiceMoods').VoiceMood;
  accent?: string;
  referenceMode: string;
  quality?: unknown;
  intonationGuide?: unknown;
}) {
  return Math.max(
    settings.outputGain !== undefined && settings.outputGain !== 1 ? 22 : 5,
    settings.intonationGuide !== undefined || settings.referenceMode === 'library' ? 21 : 5,
    settings.quality !== undefined ? 19 : 5,
    multilingualVariant(settings.variantId) ? 16 : 5,
    (settings.accent && settings.accent !== 'auto') || settings.referenceMode === 'file' ? 9 : 5,
    moodFormatVersion(settings.mood),
  );
}

export function voiceVariant(id?: string | null) {
  return installedVoiceVariants.find((v) => v.id === id);
}
