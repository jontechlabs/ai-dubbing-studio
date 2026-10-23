import catalog from '../../workers/voice-quality.json' with { type: 'json' };
export interface VoiceQuality {
  inferenceSteps?: number;
  cfgStrength?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  repetitionPenalty?: number;
  minP?: number;
  cfgWeight?: number;
  exaggeration?: number;
}
export type QualityParameter = keyof VoiceQuality;
type Spec = {
  parameters: Partial<
    Record<QualityParameter, { min: number; max: number; step: number; default: number }>
  >;
  presets: Record<string, VoiceQuality>;
};
export function qualitySpec(variant = 'cosy3-official'): Spec | undefined {
  return Object.hasOwn(catalog.variants, variant)
    ? (catalog.variants as Record<string, Spec>)[variant]
    : undefined;
}
export function validQuality(
  value: unknown,
  variant?: string | null,
): value is VoiceQuality | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const spec = qualitySpec(variant ?? undefined);
  return (
    !!spec &&
    Object.entries(value).every(([key, number]) => {
      const bounds = Object.hasOwn(spec.parameters, key)
        ? spec.parameters[key as QualityParameter]
        : undefined;
      return (
        !!bounds &&
        typeof number === 'number' &&
        Number.isFinite(number) &&
        number >= bounds.min &&
        number <= bounds.max &&
        (bounds.step !== 1 || Number.isInteger(number))
      );
    })
  );
}
export function resolvedQuality(variant: string, value?: VoiceQuality): VoiceQuality {
  const spec = qualitySpec(variant);
  return Object.fromEntries(
    Object.entries(spec?.parameters ?? {}).map(([key, bounds]) => [
      key,
      value?.[key as QualityParameter] ?? bounds.default,
    ]),
  );
}
export function qualityPreset(variant: string, value?: VoiceQuality) {
  if (value === undefined) return 'standard';
  const resolved = resolvedQuality(variant, value);
  for (const [id, preset] of Object.entries(qualitySpec(variant)?.presets ?? {})) {
    const other = resolvedQuality(variant, preset);
    if (
      Object.entries(resolved).every(([key, number]) => other[key as QualityParameter] === number)
    )
      return id;
  }
  return 'custom';
}
