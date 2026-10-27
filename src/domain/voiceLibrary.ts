import type { Project, VoiceReference, VoiceSettings } from './types';
import type { VoiceMood } from './voiceMoods';
import { validVoiceSettings } from './tts';

export interface IntonationGuide {
  mode: 'style' | 'hybrid';
  trackId?: string;
}
export interface VoiceLibrarySegment {
  referenceId: string | null;
  dialogueId: string | null;
  trackId?: string;
  startMs: number;
  endMs: number;
}
export interface VoiceLibrarySourceOptions {
  characterId: string;
  label: string;
  segments: VoiceLibrarySegment[];
}
export interface VoiceLibrarySource {
  id: string;
  reference: VoiceReference;
  segments: VoiceLibrarySegment[];
  sha256: string;
  createdAt: string;
}
export interface VoiceLibraryPhrase {
  id: string;
  label: string;
  text: string;
  mood: VoiceMood;
}
export interface VoiceLibrarySample {
  id: string;
  sourceId: string;
  reference: VoiceReference;
  text: string;
  mood: VoiceMood;
  status: 'pending' | 'approved' | 'rejected';
  options: VoiceSettings;
  sha256: string;
  createdAt: string;
  deviceName: string;
}
export interface VoiceLibrary {
  sources: VoiceLibrarySource[];
  samples: VoiceLibrarySample[];
  defaultSampleId: string | null;
}
export interface VoiceLibraryGeneration {
  characterId: string;
  sourceId: string;
  phrases: VoiceLibraryPhrase[];
  options: VoiceSettings;
}
export interface VoiceLibraryReview {
  characterId: string;
  sampleId: string;
  status: VoiceLibrarySample['status'] | null;
  transcript: string | null;
  useDefault: boolean;
}
export const frenchVoicePhrases: Omit<VoiceLibraryPhrase, 'id'>[] = [
  {
    label: 'Neutre',
    mood: 'default',
    text: 'Je pensais te retrouver ici. Nous avons encore quelques minutes pour discuter tranquillement.',
  },
  {
    label: 'Question',
    mood: 'curious',
    text: 'Tu es vraiment certain de ce que tu as vu ? Raconte-moi exactement ce qui s’est passé.',
  },
  {
    label: 'Colère',
    mood: 'angry',
    text: 'Ça suffit ! Tu vas enfin m’écouter ? Je t’avais pourtant demandé de ne pas recommencer !',
  },
  {
    label: 'Joie',
    mood: 'happy',
    text: 'C’est merveilleux ! Je savais que nous allions réussir. Viens, nous devons fêter cette nouvelle !',
  },
  {
    label: 'Tristesse',
    mood: 'sad',
    text: 'J’aurais tellement aimé lui parler une dernière fois. Maintenant, la maison me semble bien vide.',
  },
  {
    label: 'Peur',
    mood: 'afraid',
    text: 'Attends… Tu as entendu ce bruit ? Quelqu’un nous suit. Il faut partir tout de suite !',
  },
  {
    label: 'Chuchotement',
    mood: 'whisper',
    text: 'Baisse la voix. Ils sont juste derrière cette porte. Nous devons sortir sans faire de bruit.',
  },
  {
    label: 'Fatigue',
    mood: 'exhausted',
    text: 'Laisse-moi reprendre mon souffle. Nous avons marché toute la nuit et je tiens à peine debout.',
  },
];
export function libraryOf(project: Project, characterId: string | null | undefined) {
  return characterId ? project.characterProfiles?.[characterId]?.voiceLibrary : undefined;
}
export function libraryReference(
  project: Project,
  characterId: string | null,
  referenceId: string | null,
) {
  const library = libraryOf(project, characterId);
  return library?.samples.find(
    (s) => s.id === (referenceId ?? library.defaultSampleId) && s.status === 'approved',
  )?.reference;
}
export function validIntonationGuide(
  guide: unknown,
  settings: Pick<VoiceSettings, 'variantId' | 'referenceMode' | 'mode' | 'accent' | 'mood'>,
) {
  if (guide === undefined) return true;
  if (!guide || typeof guide !== 'object') return false;
  const g = guide as IntonationGuide;
  return (
    settings.variantId === 'voxcpm2-bf16' &&
    settings.referenceMode !== 'current' &&
    settings.mode === 'crossLingual' &&
    ['style', 'hybrid'].includes(g.mode) &&
    (g.trackId === undefined ||
      (typeof g.trackId === 'string' && g.trackId.length > 0 && g.trackId.length <= 128)) &&
    (g.mode !== 'hybrid' ||
      ((!settings.accent || settings.accent === 'auto') &&
        (!settings.mood || settings.mood === 'default')))
  );
}
export function editLibrarySample(
  project: Project,
  characterId: string,
  sampleId: string,
  changes: { status?: VoiceLibrarySample['status']; transcript?: string; useDefault?: boolean },
): Project {
  const next = structuredClone(project),
    library = libraryOf(next, characterId),
    sample = library?.samples.find((s) => s.id === sampleId);
  if (!library || !sample) throw Error('VOICE_LIBRARY_REFERENCE_REQUIRED');
  if (changes.transcript !== undefined) {
    sample.reference.transcript = changes.transcript.trim();
    sample.status = 'pending';
  }
  if (changes.status) {
    if (changes.status === 'approved' && !sample.reference.transcript.trim())
      throw Error('TTS_TRANSCRIPT_REQUIRED');
    sample.status = changes.status;
  }
  if (library.defaultSampleId === sampleId && sample.status !== 'approved')
    library.defaultSampleId = null;
  if (changes.useDefault) {
    if (sample.status !== 'approved') throw Error('VOICE_LIBRARY_REFERENCE_REQUIRED');
    library.defaultSampleId = sampleId;
  }
  next.formatVersion = Math.max(21, next.formatVersion);
  validateVoiceLibraries(next);
  return next;
}
export function validateVoiceLibraries(project: Project) {
  const ids = new Set(
    [...project.characters.flatMap((c) => c.references), ...(project.voiceReferences ?? [])].map(
      (r) => r.id,
    ),
  );
  const reference = (r: VoiceReference, digest: string, minimum: number) => {
    if (
      !r ||
      !r.id ||
      ids.has(r.id) ||
      !/^characters\/voice-library\/[a-zA-Z0-9-]+\.wav$/u.test(r.path) ||
      !Number.isSafeInteger(r.durationMs) ||
      r.durationMs < minimum ||
      r.durationMs > 20000 ||
      typeof r.label !== 'string' ||
      !r.label.trim() ||
      r.label.length > 400 ||
      typeof r.transcript !== 'string' ||
      r.transcript.length > 4000 ||
      !/^[a-f0-9]{64}$/u.test(digest)
    )
      throw Error('INVALID_VOICE_LIBRARY');
    ids.add(r.id);
  };
  for (const profile of Object.values(project.characterProfiles ?? {})) {
    const library = profile.voiceLibrary;
    if (!library) continue;
    if (
      project.formatVersion < 21 ||
      !Array.isArray(library.sources) ||
      !Array.isArray(library.samples) ||
      library.sources.length > 256 ||
      library.samples.length > 2000
    )
      throw Error('INVALID_VOICE_LIBRARY');
    const sourceIds = new Set<string>();
    for (const source of library.sources) {
      reference(source.reference, source.sha256, 5000);
      if (
        source.id !== source.reference.id ||
        sourceIds.has(source.id) ||
        !source.createdAt ||
        !Array.isArray(source.segments) ||
        source.segments.length < 1 ||
        source.segments.length > 16 ||
        source.segments.some(
          (s) =>
            !!s.referenceId === !!s.dialogueId ||
            !Number.isSafeInteger(s.startMs) ||
            !Number.isSafeInteger(s.endMs) ||
            s.startMs < 0 ||
            s.endMs - s.startMs < 100,
        )
      )
        throw Error('INVALID_VOICE_LIBRARY');
      sourceIds.add(source.id);
    }
    for (const sample of library.samples) {
      reference(sample.reference, sample.sha256, 1000);
      if (
        sample.id !== sample.reference.id ||
        !sourceIds.has(sample.sourceId) ||
        !['pending', 'approved', 'rejected'].includes(sample.status) ||
        typeof sample.text !== 'string' ||
        !sample.text.trim() ||
        sample.text.length > 500 ||
        !sample.createdAt ||
        !validVoiceSettings(sample.options) ||
        sample.options.variantId !== 'voxcpm2-bf16' ||
        sample.options.intonationGuide !== undefined ||
        sample.options.mood !== sample.mood ||
        typeof sample.deviceName !== 'string' ||
        (sample.status === 'approved' && !sample.reference.transcript.trim())
      )
        throw Error('INVALID_VOICE_LIBRARY');
    }
    if (
      library.defaultSampleId !== null &&
      !library.samples.some((s) => s.id === library.defaultSampleId && s.status === 'approved')
    )
      throw Error('INVALID_VOICE_LIBRARY');
  }
}
export function rebaseVoiceLibrary(
  before: VoiceLibrary | undefined,
  local: VoiceLibrary | undefined,
  incoming: VoiceLibrary | undefined,
): VoiceLibrary | undefined {
  if (!local) return undefined;
  const next = structuredClone(incoming ?? { sources: [], samples: [], defaultSampleId: null });
  const merge = <T extends { id: string }>(base: T[], edited: T[], server: T[]) => {
    const originals = new Map(base.map((v) => [v.id, v])),
      localIds = new Set(edited.map((v) => v.id));
    const result = server.filter((v) => !originals.has(v.id) || localIds.has(v.id));
    for (const entry of edited) {
      const index = result.findIndex((v) => v.id === entry.id);
      if (index < 0) result.push(structuredClone(entry));
      else if (JSON.stringify(originals.get(entry.id)) !== JSON.stringify(entry))
        result[index] = structuredClone(entry);
    }
    return result;
  };
  next.sources = merge(before?.sources ?? [], local.sources, next.sources);
  next.samples = merge(before?.samples ?? [], local.samples, next.samples);
  if (before?.defaultSampleId !== local.defaultSampleId)
    next.defaultSampleId = local.defaultSampleId;
  if (!next.samples.some((s) => s.id === next.defaultSampleId && s.status === 'approved'))
    next.defaultSampleId = null;
  return next;
}
