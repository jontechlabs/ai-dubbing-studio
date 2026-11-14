import type { Dialogue, Project } from './types';
export const manualReviewTags = ['retranslate', 'improveVoice'] as const;
export type ManualReviewTag = (typeof manualReviewTags)[number];
export interface DubbingAuditOptions {
  voices: 'off' | 'source' | 'dubbing' | 'both';
  sourceTrackId: string | null;
}
export const auditTags = [
  'missing',
  'silent',
  'multipleVoices',
  'quiet',
  'clipping',
  'cutEnd',
  'longSilence',
  'timing',
  'invalidAudio',
] as const;
export type AuditTag = (typeof auditTags)[number];
export const qualityTags = [...manualReviewTags, ...auditTags] as const;
export type QualityTag = (typeof qualityTags)[number];
export function dialogueQualityTags(line: Dialogue, row?: AuditRow): QualityTag[] {
  return [...(line.reviewTags ?? []), ...(row?.tags ?? [])];
}
export function setManualReviewTag(
  p: Project,
  lineId: string,
  tag: ManualReviewTag,
  enabled: boolean,
): Project {
  const line = p.dialogues.find((l) => l.id === lineId);
  if (!line || !manualReviewTags.includes(tag)) throw Error('INVALID_PROJECT');
  const tags = new Set(line.reviewTags ?? []);
  if (enabled) tags.add(tag);
  else tags.delete(tag);
  return {
    ...p,
    formatVersion: Math.max(29, p.formatVersion),
    dialogues: p.dialogues.map((l) => {
      if (l.id !== lineId) return l;
      const next = { ...l };
      if (tags.size) next.reviewTags = [...tags];
      else delete next.reviewTags;
      return next;
    }),
  };
}
export interface AuditRow {
  lineId: string;
  takeId: string | null;
  tags: AuditTag[];
  metrics: {
    rmsDb: number;
    peakDb: number;
    durationMs: number;
    leadingMs: number;
    trailingMs: number;
    clippedSamples: number;
    endDb: number;
    lastSample: number;
  } | null;
  sourceVoices: number | null;
  dubbingVoices: number | null;
  error: string | null;
}
export interface DubbingAudit {
  id: string;
  createdAt: string;
  basis: unknown;
  rows: AuditRow[];
  voicesStatus: string;
  sourceTrackId: string;
}
export function auditBasis(p: Project) {
  return structuredClone({
    sourcePath: p.media?.path ?? null,
    language: p.languages.target,
    lines: p.dialogues.map((l) => ({
      id: l.id,
      startMs: l.startMs,
      endMs: l.endMs,
      takeId: l.selectedGenerationIds[p.languages.target] ?? null,
      ttsText: l.ttsText ?? null,
      excluded: !!l.excludedFromDubbing,
    })),
    sourceCues: p.sourceCues,
    targetCues: p.targetCues,
    takes: p.generations
      .filter((g) => g.kind === 'tts')
      .map((g) => ({ id: g.id, path: g.path ?? null, durationMs: g.durationMs ?? null })),
    edits: p.voiceEdits ?? {},
    timing: p.dubbingTiming ?? null,
    patches: p.generations.filter((g) => g.kind === 'audioPatch'),
    groups: p.speakerDubbings ?? [],
    tracks: p.tracks
      .filter((t) => t.kind !== 'dubbing')
      .map((t) => ({ id: t.id, path: t.path ?? null, sourcePath: t.sourcePath ?? null })),
  });
}
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([k, x]) => [k, canonical(x)]),
    );
  return v;
}
export function auditFresh(p: Project) {
  return !!p.dubbingAudit && currentAuditRows(p).size === p.dubbingAudit.rows.length;
}
const currentCache = new WeakMap<Project, Map<string, AuditRow>>();
export function currentAuditRows(p: Project) {
  const cached = currentCache.get(p);
  if (cached) return cached;
  const result = new Map<string, AuditRow>();
  currentCache.set(p, result);
  if (!p.dubbingAudit) return result;
  const old = p.dubbingAudit.basis as ReturnType<typeof auditBasis>,
    now = auditBasis(p);
  const equal = (a: unknown, b: unknown) =>
    JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  if (!old || !Array.isArray(old.lines) || !Array.isArray(old.takes)) return result;
  const global = (v: typeof now) => ({
    sourcePath: v.sourcePath,
    language: v.language,
    tracks: v.tracks,
    patches: v.patches,
    groups: v.groups,
    timing: v.timing,
    times: v.lines.map((l) => ({
      id: l.id,
      startMs: l.startMs,
      endMs: l.endMs,
      excluded: l.excluded,
    })),
  });
  if (!equal(global(old), global(now))) return result;
  const oldLines = new Map(old.lines.map((l) => [l.id, l])),
    newLines = new Map(now.lines.map((l) => [l.id, l]));
  const oldTakes = new Map(old.takes.map((g) => [g.id, g])),
    newTakes = new Map(now.takes.map((g) => [g.id, g]));
  const sourceOld = new Map(old.sourceCues.map((c) => [c.id, c])),
    sourceNew = new Map(now.sourceCues.map((c) => [c.id, c]));
  const targetOld = new Map(old.targetCues.map((c) => [c.id, c])),
    targetNew = new Map(now.targetCues.map((c) => [c.id, c]));
  const lines = new Map(p.dialogues.map((l) => [l.id, l]));
  for (const row of p.dubbingAudit.rows) {
    const a = oldLines.get(row.lineId),
      b = newLines.get(row.lineId),
      line = lines.get(row.lineId);
    if (!a || !b || !line || !equal(a, b)) continue;
    const take = row.takeId;
    if (
      take &&
      (!equal(oldTakes.get(take), newTakes.get(take)) || !equal(old.edits[take], now.edits[take]))
    )
      continue;
    if (
      !line.sourceCueIds.every((id) => equal(sourceOld.get(id), sourceNew.get(id))) ||
      !line.targetCueIds.every((id) => equal(targetOld.get(id), targetNew.get(id)))
    )
      continue;
    result.set(row.lineId, row);
  }
  return result;
}
export function validateDubbingAudit(p: Project) {
  const a = p.dubbingAudit;
  if (!a) return;
  const basis = a.basis as ReturnType<typeof auditBasis>;
  if (
    !basis ||
    typeof basis !== 'object' ||
    !basis.edits ||
    typeof basis.edits !== 'object' ||
    !['lines', 'takes', 'sourceCues', 'targetCues', 'tracks', 'patches', 'groups'].every((k) =>
      Array.isArray((basis as unknown as Record<string, unknown>)[k]),
    ) ||
    ![...basis.lines, ...basis.takes, ...basis.sourceCues, ...basis.targetCues].every(
      (v) => v && typeof v === 'object' && typeof v.id === 'string',
    )
  )
    throw Error('INVALID_DUBBING_AUDIT');
  if (
    p.formatVersion < 29 ||
    !a.id ||
    !Array.isArray(a.rows) ||
    a.rows.length > 50000 ||
    new Set(a.rows.map((r) => r.lineId)).size !== a.rows.length ||
    a.rows.some(
      (r) =>
        !r.lineId ||
        !Array.isArray(r.tags) ||
        r.tags.some((t) => !auditTags.includes(t)) ||
        (r.metrics &&
          ![r.metrics.rmsDb, r.metrics.peakDb, r.metrics.endDb, r.metrics.lastSample].every(
            Number.isFinite,
          )),
    )
  )
    throw Error('INVALID_DUBBING_AUDIT');
}
