import type { Project } from './types';
export interface ProjectEntry {
  key: string;
  projectId: string;
  name: string;
  path: string;
  revision: number | null;
  updatedAt: string | null;
  lastOpenedAt: string;
  durationMs: number | null;
  source: string | null;
  target: string | null;
  hasVideo: boolean;
  available: boolean;
  error: string | null;
  trashedAt: string | null;
  coverAtMs: number | null;
}
export interface ProjectCatalogue {
  entries: ProjectEntry[];
  defaultParent: string;
  activeKey: string | null;
}
export interface ProjectCover {
  url: string;
  atMs: number;
  durationMs: number;
}
export function projectName(value: string) {
  const name = value.trim();
  if (
    !name ||
    Array.from(name).length > 160 ||
    Array.from(name).some(
      (c) => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159),
    )
  )
    throw Error('INVALID_PROJECT_NAME');
  return name;
}
export function coverPoint(durationMs: number, requested?: number) {
  const at = requested ?? Math.min(120000, Math.floor((durationMs * 2) / 5));
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    !Number.isSafeInteger(at) ||
    at < 0 ||
    at >= durationMs
  )
    throw Error('INVALID_COVER_TIME');
  return Math.min(at, Math.max(0, durationMs - 100));
}
export function browserEntry(p: Project, trashedAt?: string): ProjectEntry {
  return {
    key: p.id,
    projectId: p.id,
    name: p.name,
    path: '',
    revision: p.revision,
    updatedAt: p.updatedAt,
    lastOpenedAt: p.updatedAt,
    durationMs: p.media?.durationMs ?? null,
    source: p.languages.source,
    target: p.languages.target,
    hasVideo: !!p.media,
    available: true,
    error: null,
    trashedAt: trashedAt ?? null,
    coverAtMs: null,
  };
}
