import type { Dialogue, Generation, Project, VoiceSettings } from './types';
import { dialogueText } from './subtitles';
import { voiceVariant } from './voiceEngines';
import { validAccent } from './voiceAccents';
export function validVoiceSettings(value: unknown): value is VoiceSettings {
  if (!value || typeof value !== 'object') return false;
  const s = value as VoiceSettings;
  return (
    validAccent(s.accent, s.variantId ?? undefined) &&
    (s.mood == null ||
      ['default', 'angry', 'happy', 'sad', 'calm', 'surprised', 'whisper'].includes(s.mood)) &&
    (!s.variantId?.startsWith('qwen3') || !s.mood || s.mood === 'default') &&
    (s.variantId == null || !!voiceVariant(s.variantId)) &&
    ['character', 'current', 'custom', 'file'].includes(s.referenceMode) &&
    (s.referenceTrackId === undefined ||
      (typeof s.referenceTrackId === 'string' &&
        s.referenceTrackId.length > 0 &&
        s.referenceTrackId.length <= 128)) &&
    ['zeroShot', 'crossLingual'].includes(s.mode) &&
    Number.isFinite(s.speed) &&
    s.speed >= 0.5 &&
    s.speed <= 2 &&
    Number.isInteger(s.seed) &&
    s.seed >= 0 &&
    s.seed <= 4294967295 &&
    typeof s.device === 'string' &&
    /^(auto|cpu|cuda:\d{1,2}|vulkan:\d{1,2})$/.test(s.device)
  );
}
export function voiceGenerations(project: Project): Generation[] {
  return project.generations.filter((g): g is Generation => g.kind === 'tts');
}
export const defaultVoiceSettings: VoiceSettings = {
  accent: 'auto',
  mood: 'default',
  device: 'auto',
  referenceMode: 'character',
  referenceId: null,
  mode: 'crossLingual',
  speed: 1,
  seed: 0,
};
export function spokenText(project: Project, line: Dialogue) {
  let text = line.ttsText ?? dialogueText(project, line, 'target');
  for (const [key, value] of Object.entries(project.pronunciation).sort(
    (a, b) => b[0].length - a[0].length,
  ))
    if (key) text = text.split(key).join(value);
  return text.replace(/<[^>]*>/g, '').trim();
}
export function selectedGeneration(project: Project, line: Dialogue) {
  return voiceGenerations(project).find(
    (g) =>
      g.id === line.selectedGenerationIds[project.languages.target] &&
      g.dialogueId === line.id &&
      g.language === project.languages.target,
  );
}
export function staleGeneration(project: Project, line: Dialogue, generation: Generation) {
  if (generation.options.referenceMode === 'file') {
    const reference = project.voiceReferences?.find((r) => r.id === generation.referenceId);
    if (!reference || reference.transcript !== generation.referenceTranscript) return true;
  } else if (generation.options.referenceMode !== 'current') {
    const character = project.characters.find((c) => c.id === line.characterId);
    const reference = character?.references.find(
      (r) =>
        r.id ===
        (generation.referenceId ??
          (generation.options.referenceMode === 'custom'
            ? generation.options.referenceId
            : character.defaultReferenceId)),
    );
    if (
      generation.referenceId !== undefined &&
      (!reference ||
        reference.transcript !== generation.referenceTranscript ||
        (generation.options.referenceMode === 'character' &&
          character?.defaultReferenceId !== generation.referenceId))
    )
      return true;
  } else if (
    generation.options.mode === 'zeroShot' &&
    dialogueText(project, line, 'source') !== generation.referenceTranscript
  )
    return true;
  return (
    generation.text !== spokenText(project, line) ||
    generation.startMs !== line.startMs ||
    generation.endMs !== line.endMs ||
    generation.characterId !== line.characterId ||
    generation.sourcePath !== (project.media?.path ?? null) ||
    generation.language !== project.languages.target
  );
}
export function selectGeneration(project: Project, id: string): Project {
  const next = structuredClone(project),
    generation = voiceGenerations(next).find((g) => g.id === id);
  if (!generation) throw Error('INVALID_GENERATION');
  const line = next.dialogues.find((line) => line.id === generation.dialogueId);
  if (!line || generation.language !== next.languages.target) throw Error('INVALID_GENERATION');
  line.selectedGenerationIds[generation.language] = id;
  line.status =
    staleGeneration(next, line, generation) || generation.durationMs > line.endMs - line.startMs
      ? 'review'
      : 'generated';
  return next;
}
export function deleteGeneration(project: Project, id: string): Project {
  const next = structuredClone(project);
  next.generations = next.generations.filter((g) => g.id !== id);
  for (const line of next.dialogues)
    for (const [language, selected] of Object.entries(line.selectedGenerationIds))
      if (selected === id) {
        delete line.selectedGenerationIds[language];
        line.status = 'ungenerated';
      }
  return next;
}
export function reviewGeneration(project: Project, lineId: string, validated: boolean): Project {
  const next = structuredClone(project),
    line = next.dialogues.find((line) => line.id === lineId);
  if (!line) throw Error('NO_DIALOGUES');
  const generation = selectedGeneration(next, line);
  if (!generation || (validated && staleGeneration(next, line, generation)))
    throw Error('TTS_STALE_GENERATION');
  line.status = validated ? 'validated' : 'review';
  return next;
}
export function editVoiceSettings(
  project: Project,
  lineId: string,
  settings: VoiceSettings,
): Project {
  const next = structuredClone(project);
  const line = next.dialogues.find((line) => line.id === lineId);
  if (!line) throw Error('NO_DIALOGUES');
  line.voiceSettings = settings;
  next.formatVersion = Math.max(
    (settings.accent && settings.accent !== 'auto') || settings.referenceMode === 'file' ? 9 : 1,
    settings.mood && settings.mood !== 'default' ? 7 : 5,
    next.formatVersion,
  );
  return next;
}
