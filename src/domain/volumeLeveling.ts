import type { Project } from './types';
import { dubbingClips } from './mix';

export interface VolumeLevelingOptions {
  mediaId: string;
  trackId: string;
  startMs: number;
  endMs: number;
  mode: 'low' | 'high';
}
export interface VolumeLevelingResult {
  id: string;
  projectId: string;
  revision: number;
  options: VolumeLevelingOptions;
  stats: {
    targetDb: number;
    quietDb: number;
    loudDb: number;
    safetyDb: number;
    gainLimited: boolean;
    activeWindows: number;
  };
}
// Editor project snapshots are immutable. Reuse the rendered-clip plan and
// range signatures instead of rebuilding thousands of dialogues every tick.
const scopeCache = new WeakMap<
  Project,
  { clips: ReturnType<typeof dubbingClips>; ranges: Map<string, unknown[]> }
>();
const signatureCache = new WeakMap<object, string>();
export function dubbingLevelingScope(project: Project, startMs: number, endMs: number) {
  let cached = scopeCache.get(project);
  if (!cached) {
    cached = { clips: dubbingClips(project), ranges: new Map() };
    scopeCache.set(project, cached);
  }
  const key = `${startMs}:${endMs}`;
  const existing = cached.ranges.get(key);
  if (existing) return existing;
  const value = cached.clips
    .filter((c) => c.slotMs > 0 && c.startMs < endMs && c.startMs + c.slotMs > startMs)
    .map((c) => ({
      id: c.generation.id,
      startMs: c.startMs,
      slotMs: c.slotMs,
      durationMs: c.endMs - c.startMs,
      exactDuration: c.exactDuration,
      edit: project.voiceEdits?.[c.generation.id] ?? null,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  cached.ranges.set(key, value);
  return value;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, v]) => [key, canonical(v)]),
    );
  return value;
}
export function sameDubbingLevelingScope(a: unknown, b: unknown) {
  const signature = (value: unknown) => {
    if (value && typeof value === 'object') {
      const cached = signatureCache.get(value);
      if (cached !== undefined) return cached;
      const text = JSON.stringify(canonical(value));
      signatureCache.set(value, text);
      return text;
    }
    return JSON.stringify(value);
  };
  return signature(a) === signature(b);
}
