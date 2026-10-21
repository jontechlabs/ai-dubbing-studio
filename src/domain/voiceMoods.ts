import catalog from '../../workers/voice-moods.json' with { type: 'json' };
export type VoiceMood = keyof typeof catalog.moods;
export const voiceMoods = Object.keys(catalog.moods) as VoiceMood[];
export const moodGroups = ['positive', 'tension', 'sorrow', 'physical', 'delivery'] as const;
export function validMood(value: unknown): value is VoiceMood | undefined | null {
  return value == null || (typeof value === 'string' && Object.hasOwn(catalog.moods, value));
}
export function moodGroup(id: VoiceMood) {
  return catalog.moods[id].group;
}
export function moodFormatVersion(id: VoiceMood | undefined | null) {
  return catalog.moods[id ?? 'default'].minProjectVersion;
}
