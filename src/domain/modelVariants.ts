// Sources describe availability, not qualification in this application.
// GGUF is a container; the entire TTS pipeline still needs its matching engine.
export interface VoiceVariant {
  id: string;
  providerId: string;
  name: string;
  format: string;
  origin: 'official' | 'community';
  engine: string;
  source: string;
  detailKey: string;
  suggested16Gb: boolean;
  reportedVramGb?: number;
}
import { installedVoiceVariants } from './voiceEngines';
export const voiceVariants: VoiceVariant[] = [
  ...installedVoiceVariants
    .filter((v) => v.backend === 'vulkan')
    .map((v) => ({
      id: v.id,
      providerId: v.providerId,
      name: v.name,
      format: 'GGUF Q8_0',
      origin: 'community' as const,
      engine: 'audio.cpp 0.9.1 · Vulkan / CPU',
      source: 'https://huggingface.co/audio-cpp/audio.cpp-gguf',
      detailKey: 'phase6Gguf',
      suggested16Gb: true,
    })),
  {
    id: 'cosy3-official',
    providerId: 'cosyvoice3',
    name: 'CosyVoice3 0.5B RL',
    format: 'PyTorch',
    origin: 'official',
    engine: 'CosyVoice',
    source: 'https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512',
    detailKey: 'cosyOfficial',
    suggested16Gb: true,
  },
  {
    id: 'cosy3-gguf-q4',
    providerId: 'cosyvoice3',
    name: 'CosyVoice3 0.5B · GGUF Q4_K + Q8_0',
    format: 'GGUF',
    origin: 'community',
    engine: 'CrispASR · cosyvoice3-tts',
    source: 'https://huggingface.co/cstr/cosyvoice3-0.5b-2512-GGUF',
    detailKey: 'cosyGguf',
    suggested16Gb: true,
  },
  {
    id: 'fish-s2-fp8',
    providerId: 'fish-s2',
    name: 'Fish S2 Pro · FP8',
    format: 'FP8 E4M3',
    origin: 'community',
    engine: 'Fish S2 · FP8Linear',
    source: 'https://huggingface.co/drbaph/s2-pro-fp8',
    detailKey: 'fishFp8',
    suggested16Gb: true,
    reportedVramGb: 12,
  },
  {
    id: 'fish-s2-gguf-q6',
    providerId: 'fish-s2',
    name: 'Fish S2 Pro · GGUF Q6_K',
    format: 'GGUF Q6_K',
    origin: 'community',
    engine: 's2.cpp',
    source: 'https://huggingface.co/rodrigomt/s2-pro-gguf',
    detailKey: 'fishGguf',
    suggested16Gb: true,
  },
  {
    id: 'fish-s2-gguf-q4',
    providerId: 'fish-s2',
    name: 'Fish S2 Pro · GGUF Q4_K_M',
    format: 'GGUF Q4_K_M',
    origin: 'community',
    engine: 's2.cpp',
    source: 'https://huggingface.co/rodrigomt/s2-pro-gguf',
    detailKey: 'fishGgufSmall',
    suggested16Gb: true,
  },
  {
    id: 'fish-s2-bf16',
    providerId: 'fish-s2',
    name: 'Fish S2 Pro · BF16',
    format: 'BF16',
    origin: 'official',
    engine: 'fish-speech',
    source: 'https://speech.fish.audio/install/',
    detailKey: 'fishFull',
    suggested16Gb: false,
    reportedVramGb: 24,
  },
  {
    id: 'qwen3-06b-bf16',
    providerId: 'qwen3-tts',
    name: 'Qwen3-TTS Base 0.6B · BF16',
    format: 'BF16',
    origin: 'official',
    engine: 'qwen-tts',
    source: 'https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base',
    detailKey: 'qwenSmall',
    suggested16Gb: true,
  },
  {
    id: 'qwen3-17b-bf16',
    providerId: 'qwen3-tts',
    name: 'Qwen3-TTS Base 1.7B · BF16',
    format: 'BF16',
    origin: 'official',
    engine: 'qwen-tts',
    source: 'https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base',
    detailKey: 'qwenFull',
    suggested16Gb: false,
  },
  {
    id: 'qwen3-17b-gguf-q5',
    providerId: 'qwen3-tts',
    name: 'Qwen3-TTS Base 1.7B · GGUF Q5_K + Q8_0',
    format: 'GGUF + ONNX FP16',
    origin: 'community',
    engine: 'Qwen3-TTS-GGUF · llama.cpp + ONNX',
    source: 'https://github.com/HaujetZhao/Qwen3-TTS-GGUF',
    detailKey: 'qwenGguf',
    suggested16Gb: true,
  },
];
export function variantsFor(providerId: string | null | undefined) {
  return voiceVariants.filter((variant) => variant.providerId === providerId);
}
export function validVoiceVariant(
  providerId: string | null | undefined,
  variantId: string | null | undefined,
) {
  return !variantId || variantsFor(providerId).some((variant) => variant.id === variantId);
}
