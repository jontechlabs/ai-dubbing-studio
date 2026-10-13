import type { Cue, Dialogue, Project } from './types';
import type { SubtitleRole } from './timing';
import { cueBounds, reviewLine } from './timing';

export interface Match {
  referenceIds: string[];
  movingIds: string[];
  errorMs: number;
}
export interface Alignment {
  reference: SubtitleRole;
  rate: number;
  offsetMs: number;
  matches: Match[];
  coverage: number;
  unmatched: number;
  meanErrorMs: number;
  ambiguous: boolean;
}
const sorted = (cues: Cue[]) =>
  [...cues].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
const transformed = (cue: Cue, rate: number, offset: number): Cue => ({
  ...cue,
  startMs: Math.round(cue.startMs * rate + offset),
  endMs: Math.round(cue.endMs * rate + offset),
});

// Monotonic groups tolerate a subtitle split into up to three consecutive cues.
function match(reference: Cue[], moving: Cue[], rate: number, offset: number): Match[] {
  const shifted = moving.map((cue) => transformed(cue, rate, offset));
  const output: Match[] = [];
  let i = 0,
    j = 0;
  while (i < reference.length && j < shifted.length) {
    let best: { a: number; b: number; error: number; cost: number } | null = null;
    for (let a = 1; a <= 3 && i + a <= reference.length; a++) {
      for (let b = 1; b <= 3 && j + b <= shifted.length; b++) {
        if (a > 1 && b > 1) continue;
        const left = cueBounds(reference.slice(i, i + a)),
          right = cueBounds(shifted.slice(j, j + b));
        const error =
          (Math.abs(left.startMs - right.startMs) + Math.abs(left.endMs - right.endMs)) / 2;
        if (
          Math.abs(left.startMs - right.startMs) > 650 ||
          Math.abs(left.endMs - right.endMs) > 650
        )
          continue;
        // Do not group through a long silence.
        const continuous = (cues: Cue[]) =>
          cues.every((cue, index) => index === 0 || cue.startMs - cues[index - 1].endMs <= 1200);
        if (!continuous(reference.slice(i, i + a)) || !continuous(shifted.slice(j, j + b)))
          continue;
        const cost = error + (a + b - 2) * 150;
        if (!best || cost < best.cost) best = { a, b, error, cost };
      }
    }
    if (best) {
      output.push({
        referenceIds: reference.slice(i, i + best.a).map((c) => c.id),
        movingIds: moving.slice(j, j + best.b).map((c) => c.id),
        errorMs: best.error,
      });
      i += best.a;
      j += best.b;
    } else if (reference[i].startMs < shifted[j].startMs) i++;
    else j++;
  }
  return output;
}
function candidate(reference: Cue[], moving: Cue[], rate: number, offset: number) {
  const matches = match(reference, moving, rate, offset);
  const covered = matches.reduce((n, m) => n + m.referenceIds.length + m.movingIds.length, 0);
  const coverage = covered / (reference.length + moving.length);
  const meanErrorMs = matches.length
    ? matches.reduce((n, m) => n + m.errorMs, 0) / matches.length
    : 650;
  return {
    rate,
    offsetMs: offset,
    matches,
    coverage,
    meanErrorMs,
    score: coverage - (meanErrorMs / 650) * 0.12,
  };
}
export function analyzeAlignment(project: Project, referenceRole: SubtitleRole): Alignment {
  const reference = sorted(referenceRole === 'source' ? project.sourceCues : project.targetCues);
  const moving = sorted(referenceRole === 'source' ? project.targetCues : project.sourceCues);
  if (reference.length < 3 || moving.length < 3) throw new Error('ALIGNMENT_TOO_FEW');
  const sample = (cues: Cue[]) =>
    cues.filter((_, i) => i % Math.max(1, Math.ceil(cues.length / 160)) === 0).slice(0, 160);
  const rates = new Set([1, 25 / 24, 24 / 25, 1000 / 1001, 1001 / 1000]);
  const span = (cues: Cue[]) => cues.at(-1)!.endMs - cues[0].startMs;
  const ratio = span(reference) / span(moving);
  if (ratio >= 0.9 && ratio <= 1.1) rates.add(ratio);
  const candidates: ReturnType<typeof candidate>[] = [];
  for (const rate of rates) {
    const histogram = new Map<number, { count: number; sum: number }>();
    for (const a of sample(reference))
      for (const b of sample(moving)) {
        for (const edge of ['startMs', 'endMs'] as const) {
          const difference = a[edge] - b[edge] * rate;
          if (Math.abs(difference) > 120_000) continue;
          const bin = Math.round(difference / 200);
          const prior = histogram.get(bin) ?? { count: 0, sum: 0 };
          histogram.set(bin, { count: prior.count + 1, sum: prior.sum + difference });
        }
      }
    const offsets = [
      0,
      ...[...histogram.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 8)
        .map((bin) => bin.sum / bin.count),
    ];
    for (const offset of offsets) candidates.push(candidate(reference, moving, rate, offset));
  }
  candidates.sort((a, b) => b.score - a.score);
  let best = candidates[0];
  const referenceById = new Map(reference.map((cue) => [cue.id, cue]));
  const movingById = new Map(moving.map((cue) => [cue.id, cue]));
  // Refine drift using only independent one-to-one matches spanning the recording.
  const pairs = best.matches
    .filter((m) => m.referenceIds.length === 1 && m.movingIds.length === 1)
    .map((m) => ({
      x: movingById.get(m.movingIds[0])!.startMs,
      y: referenceById.get(m.referenceIds[0])!.startMs,
    }));
  if (pairs.length >= 3 && pairs.at(-1)!.x - pairs[0].x > 10_000) {
    const x = pairs.reduce((n, p) => n + p.x, 0) / pairs.length,
      y = pairs.reduce((n, p) => n + p.y, 0) / pairs.length;
    const rate =
      pairs.reduce((n, p) => n + (p.x - x) * (p.y - y), 0) /
      pairs.reduce((n, p) => n + (p.x - x) ** 2, 0);
    if (rate >= 0.9 && rate <= 1.1) {
      const refined = candidate(reference, moving, rate, y - rate * x);
      if (refined.score >= best.score) best = refined;
    }
  }
  const rival = candidates.find(
    (c) =>
      Math.abs(c.offsetMs - best.offsetMs) + Math.abs(c.rate - best.rate) * span(moving) > 1000,
  );
  const ambiguous =
    best.matches.length < 3 ||
    best.coverage < 0.6 ||
    Boolean(rival && rival.score > best.score - 0.07);
  const matched = best.matches.reduce((n, m) => n + m.referenceIds.length + m.movingIds.length, 0);
  return {
    reference: referenceRole,
    rate: best.rate,
    offsetMs: Math.round(best.offsetMs),
    matches: best.matches,
    coverage: best.coverage,
    unmatched: reference.length + moving.length - matched,
    meanErrorMs: Math.round(best.meanErrorMs),
    ambiguous,
  };
}

export function applyAlignment(project: Project, proposal: Alignment): Project {
  if (proposal.ambiguous) throw new Error('ALIGNMENT_AMBIGUOUS');
  const next = structuredClone(project);
  const reference = proposal.reference === 'source' ? next.sourceCues : next.targetCues;
  const moving = proposal.reference === 'source' ? next.targetCues : next.sourceCues;
  const referenceById = new Map(reference.map((cue) => [cue.id, cue]));
  const movingById = new Map(moving.map((cue) => [cue.id, cue]));
  const sourceById = new Map(next.sourceCues.map((cue) => [cue.id, cue]));
  const targetById = new Map(next.targetCues.map((cue) => [cue.id, cue]));
  const previousByCue = new Map<string, Dialogue[]>();
  for (const line of project.dialogues) {
    for (const [role, ids] of [
      ['source', line.sourceCueIds],
      ['target', line.targetCueIds],
    ] as const)
      for (const id of ids)
        previousByCue.set(`${role}:${id}`, [...(previousByCue.get(`${role}:${id}`) ?? []), line]);
  }
  // Only confirmed groups are changed. Unmatched cues retain their original timings.
  for (const group of proposal.matches) {
    const left = group.referenceIds
      .map((id) => referenceById.get(id))
      .filter((c): c is Cue => Boolean(c));
    const right = group.movingIds
      .map((id) => movingById.get(id))
      .filter((c): c is Cue => Boolean(c));
    if (left.length !== group.referenceIds.length || right.length !== group.movingIds.length)
      throw new Error('STALE_REVISION');
    const a = cueBounds(left),
      b = cueBounds(right);
    const rate = (a.endMs - a.startMs) / (b.endMs - b.startMs);
    for (const cue of right) {
      const startMs = Math.round(a.startMs + (cue.startMs - b.startMs) * rate);
      const endMs = Math.round(a.startMs + (cue.endMs - b.startMs) * rate);
      if (startMs < 0 || endMs <= startMs) throw new Error('INVALID_CUE_RANGE');
      Object.assign(cue, { startMs, endMs });
    }
  }
  const usedSource = new Set<string>(),
    usedTarget = new Set<string>(),
    usedLines = new Set<string>(),
    usedOverrides = new Set<string>();
  const make = (sourceCueIds: string[], targetCueIds: string[], unmatched: boolean): Dialogue => {
    sourceCueIds.forEach((id) => usedSource.add(id));
    targetCueIds.forEach((id) => usedTarget.add(id));
    const previous = [
      ...new Set([
        ...sourceCueIds.flatMap((id) => previousByCue.get(`source:${id}`) ?? []),
        ...targetCueIds.flatMap((id) => previousByCue.get(`target:${id}`) ?? []),
      ]),
    ];
    const prior = previous.find((line) => !usedLines.has(line.id));
    const id = prior?.id ?? crypto.randomUUID();
    usedLines.add(id);
    const bounds = cueBounds([
      ...sourceCueIds.map((id) => sourceById.get(id)!),
      ...targetCueIds.map((id) => targetById.get(id)!),
    ]);
    // TTS overrides follow their cue group once, so a many-to-one association loses no text.
    const overrides = previous.filter(
      (line) => line.ttsText !== null && !usedOverrides.has(line.id),
    );
    overrides.forEach((line) => usedOverrides.add(line.id));
    return reviewLine(
      {
        id,
        ...bounds,
        sourceCueIds,
        targetCueIds,
        ttsText: overrides.length ? overrides.map((line) => line.ttsText).join('\n') : null,
        characterId: prior?.characterId ?? null,
        status: prior?.status ?? 'ungenerated',
        selectedGenerationIds: {},
        warnings: [
          ...new Set(previous.flatMap((line) => line.warnings).filter((w) => w !== 'alignment')),
        ],
      },
      unmatched ? 'alignment' : 'timing',
    );
  };
  next.dialogues = proposal.matches.map((group) =>
    make(
      proposal.reference === 'source' ? group.referenceIds : group.movingIds,
      proposal.reference === 'source' ? group.movingIds : group.referenceIds,
      false,
    ),
  );
  for (const cue of next.sourceCues)
    if (!usedSource.has(cue.id)) next.dialogues.push(make([cue.id], [], true));
  for (const cue of next.targetCues)
    if (!usedTarget.has(cue.id)) next.dialogues.push(make([], [cue.id], true));
  next.dialogues.sort((a, b) => a.startMs - b.startMs);
  return next;
}
