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
] as const;
export function voiceVariant(id?: string | null) {
  return installedVoiceVariants.find((v) => v.id === id);
}
