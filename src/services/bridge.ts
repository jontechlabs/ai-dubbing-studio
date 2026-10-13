import { convertFileSrc, invoke as invokeNative, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { blankProject, demoProject, validateProject } from '../domain/project';
import { alignCues, exportSrt, parseSrt, reconcileDialogues } from '../domain/subtitles';
import type { EnvironmentInfo, Job, MediaInfo, Project } from '../domain/types';
import { browserStore, downloadText, pickBrowserFile } from './browserStore';
import { audioPeaks, type Waveform } from '../domain/waveform';

export const native = isTauri();
const commandErrors: string[] = [];
export function diagnosticErrors() {
  return [...commandErrors];
}
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invokeNative<T>(command, args);
  } catch (error) {
    commandErrors.push(`${new Date().toISOString()} ${command}: ${String(error)}`);
    if (commandErrors.length > 50) commandErrors.shift();
    throw error;
  }
}
export async function exportReport(name: string, content: string) {
  if (!native) {
    downloadText(name, content);
    return;
  }
  const path = await save({ defaultPath: name, filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (path) await invoke('export_report', { path, content });
}
let browserProject: Project | null = null;
let mediaBlob: Blob | null = null;
const mediaFiles = new Map<string, File>();
const undoStack: Project[] = [];
const redoStack: Project[] = [];
let playbackUrl: string | null = null;

async function storeBrowser(project: Project) {
  await browserStore('put', project.id, { project, media: mediaBlob });
  localStorage.setItem('studio.lastProject', project.id);
  browserProject = project;
  return project;
}
export async function restoreProject(): Promise<Project | null> {
  if (native) return invoke('restore_project');
  const id = localStorage.getItem('studio.lastProject');
  if (!id) return null;
  const record = await browserStore('get', id);
  if (!record) return null;
  mediaBlob = record.media;
  browserProject = validateProject(record.project);
  return browserProject;
}
export async function createProject(
  name: string,
  source: string,
  target: string,
): Promise<Project | null> {
  if (native) {
    const parentPath = await open({ directory: true, multiple: false });
    return parentPath ? invoke('create_project', { parentPath, name, source, target }) : null;
  }
  mediaBlob = null;
  undoStack.length = 0;
  redoStack.length = 0;
  return storeBrowser(blankProject(name, source, target));
}
export async function openProject(): Promise<Project | null> {
  if (native) {
    const path = await open({ directory: true, multiple: false });
    return path ? invoke('open_project', { path }) : null;
  }
  const file = await pickBrowserFile('.json');
  if (!file) return null;
  const project = validateProject(JSON.parse(await file.text()));
  const stored = await browserStore('get', project.id);
  mediaBlob = stored?.media ?? null;
  undoStack.length = 0;
  redoStack.length = 0;
  return storeBrowser(project);
}
export async function loadDemo(): Promise<Project> {
  if (native) return invoke('load_demo');
  mediaBlob = null;
  undoStack.length = 0;
  redoStack.length = 0;
  return storeBrowser(demoProject());
}
export async function replaceProject(project: Project, expectedRevision: number): Promise<Project> {
  if (native) return invoke('replace_project', { project, expectedRevision });
  validateProject(project);
  if (browserProject?.revision !== expectedRevision) throw new Error('STALE_REVISION');
  if (browserProject) undoStack.push(structuredClone(browserProject));
  redoStack.length = 0;
  return storeBrowser({
    ...project,
    revision: expectedRevision + 1,
    updatedAt: new Date().toISOString(),
  });
}
export async function history(direction: 'undo' | 'redo'): Promise<Project | null> {
  if (native) return invoke('history', { direction });
  const from = direction === 'undo' ? undoStack : redoStack;
  const to = direction === 'undo' ? redoStack : undoStack;
  const project = from.pop();
  if (!project || !browserProject) return browserProject;
  to.push(structuredClone(browserProject));
  return storeBrowser({ ...project, revision: browserProject.revision + 1 });
}
export async function chooseMedia(): Promise<{ path: string; info: MediaInfo } | null> {
  if (native) {
    const path = await open({
      multiple: false,
      filters: [{ name: 'Video', extensions: ['mkv', 'mp4', 'mov', 'avi', 'webm'] }],
    });
    return path ? { path, info: await invoke('probe_media', { path }) } : null;
  }
  const file = await pickBrowserFile('video/*,.mkv,.mp4,.mov,.avi,.webm');
  if (!file) return null;
  const path = crypto.randomUUID();
  mediaFiles.set(path, file);
  const url = URL.createObjectURL(file);
  const durationMs = await new Promise<number>((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = url;
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Math.round(video.duration * 1000));
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('PROCESS_FAILED'));
    };
  });
  return { path, info: { originalName: file.name, durationMs, streams: [] } };
}
export async function importMedia(
  path: string,
  audioStreamIndex: number | null,
): Promise<Project | null> {
  if (native) {
    await invoke('import_media', { path, audioStreamIndex, forceProxy: false });
    return null;
  }
  const file = mediaFiles.get(path);
  if (!file || !browserProject) throw new Error('NO_PROJECT');
  mediaBlob = file;
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error('PROCESS_FAILED'));
  });
  const durationMs = Math.round(video.duration * 1000);
  URL.revokeObjectURL(url);
  return storeBrowser({
    ...browserProject,
    revision: browserProject.revision + 1,
    media: {
      id: path,
      path: file.name,
      previewPath: null,
      originalName: file.name,
      durationMs,
      streams: [],
      audioStreamIndex,
    },
  });
}
export async function prepareProxy(): Promise<void> {
  if (native) await invoke('prepare_proxy');
}
export async function importSubtitles(role: 'source' | 'target'): Promise<Project | null> {
  if (native) {
    const path = await open({ multiple: false, filters: [{ name: 'SRT', extensions: ['srt'] }] });
    return path ? invoke('import_subtitles', { path, role }) : null;
  }
  const file = await pickBrowserFile('.srt');
  if (!file || !browserProject) return null;
  const project = structuredClone(browserProject);
  project[role === 'source' ? 'sourceCues' : 'targetCues'] = parseSrt(await file.text());
  project.dialogues = reconcileDialogues(
    project.dialogues,
    alignCues(project.sourceCues, project.targetCues),
  );
  return replaceProject(project, browserProject.revision);
}
export async function mediaUrl(project: Project): Promise<string | null> {
  if (!project.media) return null;
  if (native) return convertFileSrc(await invoke<string>('media_path'));
  if (playbackUrl) URL.revokeObjectURL(playbackUrl);
  playbackUrl = null;
  if (mediaBlob) {
    playbackUrl = URL.createObjectURL(mediaBlob);
    return playbackUrl;
  }
  return project.media.path === 'demo.mp4' ? '/demo.mp4' : null;
}
export async function waveform(project: Project): Promise<Waveform | null> {
  if (native) return invoke('get_waveform');
  const blob = mediaBlob;
  const bytes = blob
    ? await blob.arrayBuffer()
    : project.media?.path === 'demo.mp4'
      ? await (await fetch('/demo.mp4')).arrayBuffer()
      : null;
  if (!bytes) return null;
  const context = new OfflineAudioContext(1, 1, 8000);
  const audio = await context.decodeAudioData(bytes);
  const mono = new Float32Array(audio.length);
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const samples = audio.getChannelData(channel);
    for (let i = 0; i < mono.length; i++) mono[i] += samples[i] / audio.numberOfChannels;
  }
  return audioPeaks(mono, audio.sampleRate);
}
export async function importEmbeddedSubtitles(role: 'source' | 'target', streamIndex: number) {
  if (!native) throw new Error('DESKTOP_REQUIRED');
  return invoke<Project>('import_embedded_subtitles', { role, streamIndex });
}
export async function exportSubtitles(project: Project, role: 'source' | 'target') {
  const content = exportSrt(role === 'source' ? project.sourceCues : project.targetCues);
  if (!native) {
    downloadText(`${role}.srt`, content);
    return;
  }
  const path = await save({
    defaultPath: `${role}.srt`,
    filters: [{ name: 'SRT', extensions: ['srt'] }],
  });
  if (path) await invoke('export_subtitles', { path, role });
}
export async function environment(): Promise<EnvironmentInfo> {
  return native ? invoke('environment') : { platform: 'browser', ffmpeg: false, ffprobe: false };
}
export async function jobs(): Promise<Job[]> {
  return native ? invoke('list_jobs') : [];
}
export async function cancelJob(id: string): Promise<void> {
  if (native) await invoke('cancel_job', { id });
}
export async function retryJob(id: string): Promise<void> {
  if (native) await invoke('retry_job', { id });
}
export async function subscribe(
  onProject: (p: Project) => void,
  onJob: (j: Job) => void,
): Promise<() => void> {
  if (!native) return () => {};
  const a = await listen<Project>('project-changed', (event) => onProject(event.payload));
  const b = await listen<Job>('job-changed', (event) => onJob(event.payload));
  return () => {
    a();
    b();
  };
}
