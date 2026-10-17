import catalog from '../../workers/voice-accents.json' with { type: 'json' };
export const voiceAccents = catalog.accents;
export function accentSupported(variantId: string, language?: string) {
  return (
    (variantId === 'cosy3-official' ||
      variantId.startsWith('fish-s2') ||
      variantId === 'drama3-comfy-fp8') &&
    (language === undefined || voiceAccents.some((accent) => accent.language === language))
  );
}
export function validAccent(accent: unknown, variantId = 'cosy3-official') {
  return (
    accent == null ||
    accent === 'auto' ||
    (accentSupported(variantId) && voiceAccents.some((item) => item.id === accent))
  );
}
