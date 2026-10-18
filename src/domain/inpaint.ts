import type { Project } from './types';
import type { MouthRegion } from './lips';
import { dubbingClips } from './mix';
export interface InpaintOptions {
  lineId: string;
  generationId: string;
  device: string;
  face: MouthRegion;
  endX: number;
  endY: number;
  mask: MouthRegion;
  feather: number;
  blend: number;
  style: 'anime' | 'live';
  seed: number;
}
export interface LipVideo {
  kind: 'lipVideo';
  id: string;
  dialogueId: string;
  generationId: string;
  sourcePath: string;
  language: string;
  path: string;
  startMs: number;
  durationMs: number;
  slotMs: number;
  exactDuration: boolean;
  fingerprint: string;
  voiceEditKey?: string;
  enabled: boolean;
  options: InpaintOptions;
  createdAt: string;
  modelRevision: string;
}
export const lipVideos = (project: Project) =>
  project.generations.filter((g) => g.kind === 'lipVideo') as unknown as LipVideo[];
export function currentLipVideo(project: Project, edit: LipVideo) {
  let sameAudio = false;
  try {
    sameAudio =
      JSON.stringify(JSON.parse(edit.voiceEditKey || 'null')) ===
      JSON.stringify(project.voiceEdits?.[edit.generationId] ?? null);
  } catch {
    /* Malformed metadata cannot activate a retouched variant. */
  }
  const clip = dubbingClips(project).find(
    (c) => c.line.id === edit.dialogueId && c.generation.id === edit.generationId,
  );
  return (
    !!clip &&
    sameAudio &&
    edit.sourcePath === project.media?.path &&
    edit.language === project.languages.target &&
    edit.startMs === clip.startMs &&
    edit.durationMs === Math.floor((clip.endMs - clip.startMs) / 40) * 40 &&
    edit.slotMs === clip.slotMs &&
    edit.exactDuration === clip.exactDuration
  );
}
export function selectLipVideo(project: Project, id: string, enabled: boolean): Project {
  const edits = lipVideos(project),
    selected = edits.find((e) => e.id === id);
  if (!selected || (enabled && !currentLipVideo(project, selected))) throw Error('INPAINT_STALE');
  const next = structuredClone(project);
  for (const g of next.generations)
    if (g.kind === 'lipVideo') {
      if (g.id === id) g.enabled = enabled;
      else if (
        enabled &&
        g.dialogueId === selected.dialogueId &&
        g.sourcePath === selected.sourcePath &&
        g.language === selected.language
      )
        g.enabled = false;
    }
  next.formatVersion = Math.max(8, next.formatVersion);
  validateLipVideos(next);
  return next;
}
export function validateLipVideos(project: Project) {
  const region = (r: MouthRegion) =>
    r &&
    [r.x, r.y, r.width, r.height].every(Number.isFinite) &&
    r.x >= 0 &&
    r.y >= 0 &&
    r.width >= 0.01 &&
    r.height >= 0.01 &&
    r.x + r.width <= 1.000001 &&
    r.y + r.height <= 1.000001;
  const active: LipVideo[] = [];
  for (const e of lipVideos(project)) {
    const o = e.options;
    if (
      project.formatVersion < 8 ||
      !e.id ||
      project.generations.filter((g) => g.id === e.id).length !== 1 ||
      e.path !== `generations/lips-${e.id}.mp4` ||
      e.id.includes('/') ||
      e.id.includes('\\') ||
      e.id.includes('..') ||
      !e.sourcePath ||
      /[\\:]|\.\./.test(e.sourcePath) ||
      !/^[a-f0-9]{64}$/.test(e.fingerprint) ||
      !Number.isSafeInteger(e.startMs) ||
      e.startMs < 0 ||
      e.startMs > 86400000 ||
      !Number.isSafeInteger(e.durationMs) ||
      e.durationMs < 200 ||
      e.durationMs > 10000 ||
      !Number.isSafeInteger(e.slotMs) ||
      e.slotMs < 1 ||
      e.slotMs > 120000 ||
      typeof e.exactDuration !== 'boolean' ||
      typeof e.enabled !== 'boolean' ||
      !o ||
      !region(o.face) ||
      !region(o.mask) ||
      !region({ ...o.face, x: o.endX, y: o.endY }) ||
      !/^cuda:\d{1,3}$/.test(o.device) ||
      !['anime', 'live'].includes(o.style) ||
      !Number.isFinite(o.feather) ||
      o.feather < 0.01 ||
      o.feather > 0.45 ||
      !Number.isFinite(o.blend) ||
      o.blend < 0.1 ||
      o.blend > 1 ||
      !Number.isSafeInteger(o.seed) ||
      o.seed < 0 ||
      o.seed > 4294967295 ||
      o.lineId !== e.dialogueId ||
      o.generationId !== e.generationId
    )
      throw Error('INPAINT_INVALID_VARIANT');
    if (e.enabled) active.push(e);
  }
  active.sort((a, b) => a.startMs - b.startMs);
  if (active.some((e, i) => i > 0 && e.startMs < active[i - 1].startMs + active[i - 1].durationMs))
    throw Error('INPAINT_OVERLAP');
}
