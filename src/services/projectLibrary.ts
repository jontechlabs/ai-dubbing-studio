import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
  browserStore,
  browserProjects,
  browserMetadata,
  forgetBrowserProject,
} from './browserStore';
import {
  browserEntry,
  projectName,
  coverPoint,
  type ProjectCatalogue,
  type ProjectCover,
} from '../domain/projectLibrary';
import { validateProject } from '../domain/project';
const native = isTauri();
export async function catalogue(): Promise<ProjectCatalogue> {
  if (native) return invoke('list_projects');
  return {
    entries: (await browserProjects())
      .map((r) => ({
        ...browserEntry(validateProject(r.project), r.trashedAt),
        coverAtMs: r.cover?.atMs ?? null,
      }))
      .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt)),
    defaultParent: '',
    activeKey: null,
  };
}
export async function chooseProjectParent(): Promise<string | null> {
  return native ? open({ directory: true, multiple: false }) : null;
}
export async function renameProject(key: string, expectedRevision: number, name: string) {
  name = projectName(name);
  if (native) return invoke('rename_registered_project', { key, expectedRevision, name });
  const record = await browserStore('get', key);
  if (!record) throw Error('PROJECT_NOT_FOUND');
  if (record.project.revision !== expectedRevision) throw Error('STALE_REVISION');
  const p = {
    ...record.project,
    name,
    revision: expectedRevision + 1,
    updatedAt: new Date().toISOString(),
  };
  await browserStore('put', key, { media: record.media, project: p });
  return browserEntry(p);
}
export async function trashProject(key: string, expectedRevision: number, confirmed: boolean) {
  if (native) return invoke('trash_registered_project', { key, expectedRevision, confirmed });
  if (!confirmed) throw Error('PROJECT_DELETE_CONFIRMATION');
  const r = await browserStore('get', key);
  if (!r) throw Error('PROJECT_NOT_FOUND');
  if (r.project.revision !== expectedRevision) throw Error('STALE_REVISION');
  await browserMetadata(key, { trashedAt: new Date().toISOString() });
}
export async function restoreProject(key: string, parentPath?: string) {
  if (native) return invoke('restore_registered_project', { key, parentPath: parentPath ?? null });
  const r = await browserStore('get', key);
  if (!r) throw Error('PROJECT_NOT_FOUND');
  await browserMetadata(key, { trashedAt: undefined });
}
export async function forgetProject(key: string, confirmed: boolean) {
  if (!confirmed) throw Error('PROJECT_DELETE_CONFIRMATION');
  if (native) await invoke('forget_registered_project', { key, confirmed });
  else await forgetBrowserProject(key);
}
const coverCache = new Map<string, ProjectCover>();
let queue: Promise<unknown> = Promise.resolve();
/** Serialize visible-card previews without changing the editor session. */
export function projectCover(
  key: string,
  atMs?: number,
  signal?: AbortSignal,
): Promise<ProjectCover> {
  const task = queue
    .catch(() => {})
    .then(() => {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return loadCover(key, atMs);
    });
  queue = task;
  return task;
}
async function loadCover(key: string, atMs?: number): Promise<ProjectCover> {
  if (native) {
    const r = await invoke<{ path: string; atMs: number; durationMs: number }>('project_cover', {
      key,
      atMs: atMs ?? null,
    });
    return { url: convertFileSrc(r.path), atMs: r.atMs, durationMs: r.durationMs };
  }
  const record = await browserStore('get', key);
  if (!record?.project.media) throw Error('MEDIA_MISSING');
  const media = record.project.media;
  const source = [media.id, media.durationMs, record.media?.size ?? 0].join(':');
  const cacheKey = key + source;
  const previous = record.cover?.source === source ? record.cover : coverCache.get(cacheKey);
  if (previous && atMs === undefined) return previous;
  const at = coverPoint(media.durationMs, atMs),
    src = record.media
      ? URL.createObjectURL(record.media)
      : (media.previewPath ?? (media.path === 'demo.mp4' ? '/demo.mp4' : null));
  if (!src) throw Error('MEDIA_MISSING');
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.src = src;
  try {
    return await new Promise<ProjectCover>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('PROCESS_FAILED')), 15000);
      const fail = () => {
        clearTimeout(timer);
        reject(Error('MEDIA_MISSING'));
      };
      let captured = false;
      const capture = () => {
        if (captured) return;
        captured = true;
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 480;
          canvas.height = Math.max(1, Math.round((480 * video.videoHeight) / video.videoWidth));
          canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
          const c = {
            url: canvas.toDataURL('image/jpeg', 0.8),
            atMs: at,
            durationMs: media.durationMs,
          };
          coverCache.set(cacheKey, c);
          clearTimeout(timer);
          void browserMetadata(key, { cover: { ...c, source } }).then(() => resolve(c), reject);
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      };
      video.onerror = fail;
      video.onloadedmetadata = () => {
        if (at > 0) video.currentTime = at / 1000;
      };
      video.onloadeddata = () => {
        if (at === 0) capture();
      };
      video.onseeked = capture;
      video.load();
    });
  } finally {
    video.removeAttribute('src');
    video.load();
    if (record.media) URL.revokeObjectURL(src);
  }
}
