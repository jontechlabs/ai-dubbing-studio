import { convertFileSrc, invoke as invokeNative, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { blankProject, demoProject, validateProject } from '../domain/project';
import { alignCues, exportSrt, parseSrt, reconcileDialogues } from '../domain/subtitles';
import type { EnvironmentInfo, Job, MediaInfo, Project, Track } from '../domain/types';
import { browserStore, downloadText, pickBrowserFile } from './browserStore';
import { audioPeaks, type Waveform } from '../domain/waveform';

export const native = isTauri();
export interface CharacterMatchOptions {
  lineId: string;
  trackId: string | null;
}
export interface CharacterSuggestion {
  id: string;
  lineId: string;
  candidates: { characterId: string; score: number }[];
  reason: string;
  reliable: boolean;
  stale: boolean;
}
export function suggestDialogueCharacter(options: CharacterMatchOptions) {
  return invoke<string>('suggest_dialogue_character', { options });
}
export function characterSuggestionResult(id: string) {
  return invoke<CharacterSuggestion>('character_suggestion_result', { id });
}
export function acceptCharacterSuggestion(id: string, characterId: string) {
  return invoke<Project>('accept_character_suggestion', { id, characterId });
}
export function prepareVoiceLibrarySource(
  options: import('../domain/voiceLibrary').VoiceLibrarySourceOptions,
) {
  return invoke<Project>('prepare_voice_library_source', { options });
}
export function generateVoiceLibrary(
  options: import('../domain/voiceLibrary').VoiceLibraryGeneration,
) {
  return invoke<string>('generate_voice_library', { options });
}
export async function voiceLibraryAudioUrl(characterId: string, referenceId: string) {
  return convertFileSrc(
    await invoke<string>('voice_library_audio_path', { characterId, referenceId }),
  );
}

export function applyAudioEffects(options: import('../domain/audioEffects').AudioEffectsOptions) {
  return invoke<string>('apply_audio_effects', { options });
}
export function transferAudio(options: import('../domain/audioPatch').TransferOptions) {
  return invoke<string>('transfer_audio', { options });
}
export async function audioPatchUrl(id: string) {
  return convertFileSrc(await invoke<string>('audio_patch_path', { id }));
}
export interface InpaintStatus {
  modelId?: import('../domain/inpaint').InpaintModelId;
  space?: { path: string; availableBytes: number; requiredBytes: number; enough: boolean };
  installed: boolean;
  sizeBytes: number;
  devices: { id: string; name: string; memoryMb: number }[];
}
export function inpaintStatus(
  modelId: import('../domain/inpaint').InpaintModelId = 'musetalk-15-fp16',
) {
  return invoke<InpaintStatus>('inpaint_status', { modelId });
}
export function installInpaint(
  modelId: import('../domain/inpaint').InpaintModelId = 'musetalk-15-fp16',
) {
  return invoke<string>('install_inpaint', { modelId });
}
export function inpaintLips(options: import('../domain/inpaint').InpaintOptions) {
  return invoke<string>('inpaint_lips', { options });
}
export interface InpaintBatchSelection {
  scope: 'all' | 'selected';
  lineIds: string[];
  force: boolean;
  useSavedCrops: boolean;
  useCommonCrop: boolean;
  activate: boolean;
  crops: Record<
    string,
    Pick<import('../domain/inpaint').InpaintOptions, 'face' | 'endX' | 'endY' | 'mask'>
  >;
  options: import('../domain/inpaint').InpaintOptions;
}
export interface InpaintBatchPreview {
  requested: number;
  undubbed: number;
  existing: number;
  missingCrop: number;
  ready: string[];
  blocked: { lineId: string; error: string }[];
}
export function previewInpaintBatch(selection: InpaintBatchSelection) {
  return invoke<InpaintBatchPreview>('preview_inpaint_batch', { selection });
}
export function startInpaintBatch(selection: InpaintBatchSelection) {
  return invoke<string>('start_inpaint_batch', { selection });
}
export interface FaceProposals {
  projectId: string;
  sourcePath: string;
  items: {
    lineId: string;
    generationId: string;
    fingerprint: string;
    crop: InpaintBatchSelection['crops'][string] | null;
    reason: string | null;
  }[];
}
export function detectInpaintFaces(selection: InpaintBatchSelection, profile: string) {
  return invoke<string>('detect_inpaint_faces', { selection, profile });
}
export function faceDetectionResult(id: string) {
  return invoke<FaceProposals | null>('face_detection_result', { id });
}
export async function inpaintUrl(id: string) {
  return convertFileSrc(await invoke<string>('inpaint_path', { id }));
}
export function analyzeLips(options: import('../domain/lips').LipOptions) {
  return invoke<string>('analyze_lips', { options });
}
export function lipAnalysisResult(id: string) {
  return invoke<import('../domain/lips').LipAnalysis | null>('lip_analysis_result', { id });
}
export function latestLipAnalysis(lineId: string, generationId: string) {
  return invoke<string | null>('latest_lip_analysis', { lineId, generationId });
}
export interface VoiceStatus {
  variants: { id: string; installed: boolean; sizeBytes: number }[];
  devices: { id: string; name: string; discrete?: boolean }[];
  cudaDevices: { id: string; name: string }[];
}
export function voiceStatus(includeCuda = false) {
  return invoke<VoiceStatus>('voice_status', { includeCuda });
}
export function installVoiceRuntime(variantId: string) {
  return invoke<string>('install_voice_runtime', { variantId });
}
export interface VoiceInstallSpace {
  path: string;
  availableBytes: number;
  requiredBytes: number;
  modelBytes: number;
  downloadBytes: number;
  runtimeBytes: number;
  marginBytes: number;
  enough: boolean;
}
export function voiceInstallSpace(variantId?: string) {
  return invoke<VoiceInstallSpace>('voice_install_space', { variantId });
}
export interface TtsStatus {
  installed: boolean;
  installing: boolean;
  sizeBytes: number;
  inventory: {
    devices: { id: string; name: string }[];
    unavailableDevices?: { id: string; name: string; reason: string }[];
    cudaVersion?: string | null;
    warning?: string | null;
  };
}
export function ttsStatus() {
  return invoke<TtsStatus>('tts_status');
}
export function installTtsRuntime(cuda: boolean) {
  return invoke<string>('install_tts_runtime', { cuda });
}
export function generateLine(lineId: string, options: import('../domain/types').VoiceSettings) {
  return invoke<string>('generate_line', { lineId, options });
}
export function storeMicrophoneTake(
  projectId: string,
  expectedRevision: number,
  lineId: string,
  bytes: ArrayBuffer,
) {
  return invokeNative<Project>('mcp_store_microphone_take', bytes, {
    headers: { 'x-studio-capture': JSON.stringify({ projectId, expectedRevision, lineId }) },
  });
}
export function convertVoiceTimbre(
  options: import('../domain/voiceCapture').VoiceConversionOptions,
) {
  return invoke<string>('convert_voice_timbre', { options });
}
export function prosodyStatus() {
  return invoke<{
    available: boolean;
    version: string;
    maxDurationMs: number;
    experimental: boolean;
    device: string;
  }>('prosody_status');
}
export function transferVoiceProsody(options: import('../domain/prosody').ProsodyOptions) {
  return invoke<string>('transfer_voice_prosody', { options });
}
export async function generationUrl(id: string, edit?: import('../domain/voiceEdit').VoiceEdit) {
  if (!native) throw Error('DESKTOP_REQUIRED');
  return convertFileSrc(await invoke<string>('generation_path', { id, edit: edit ?? null }));
}
export async function dubbingUrl(
  id: string,
  slotMs: number,
  exactDuration = false,
  edit?: import('../domain/voiceEdit').VoiceEdit,
) {
  if (!native) throw Error('DESKTOP_REQUIRED');
  return convertFileSrc(
    await invoke<string>('dubbing_path', { id, slotMs, exactDuration, edit: edit ?? null }),
  );
}
export async function exportGeneration(id: string, edit?: import('../domain/voiceEdit').VoiceEdit) {
  const path = await save({
    defaultPath: `doublage-${id.slice(0, 8)}.wav`,
    filters: [{ name: 'WAV', extensions: ['wav'] }],
  });
  if (path) await invoke('export_generation', { id, path, edit: edit ?? null });
}
export interface MkvOptions {
  includeRetouched?: boolean;
  includeOriginal: boolean;
  sourceSubtitles: boolean;
  targetSubtitles: boolean;
  codec: 'aac' | 'flac';
  allowIncomplete: boolean;
}
export async function exportMkv(project: Project, options: MkvOptions) {
  const path = await save({
    defaultPath: `${project.name.replace(/[<>:"/\\|?*]/g, '_')}-dub.mkv`,
    filters: [{ name: 'Matroska', extensions: ['mkv'] }],
  });
  if (!path) return null;
  return invoke<string>('export_mkv', { path, options });
}
export interface ModelStorageInfo {
  path: string;
  defaultPath: string;
  moving: boolean;
}
export function modelStorageInfo() {
  return invoke<ModelStorageInfo>('model_storage_info');
}
export interface ModelStorageSize {
  path: string;
  bytes: number;
  files: number;
  skipped: number;
  partial: boolean;
}
export function modelStorageSize() {
  return invoke<ModelStorageSize>('model_storage_size');
}
export function changeModelStorage(path: string) {
  return invoke<string>('change_model_storage', { path });
}
export async function pickModelDirectory() {
  const path = await open({ directory: true, multiple: false });
  return typeof path === 'string' ? path : null;
}
export function speakerStatus() {
  return invoke<{ installed: boolean; installing: boolean; sizeBytes: number }>('speaker_status');
}
export function installSpeakerRuntime() {
  return invoke<string>('install_speaker_runtime');
}
export function identifySpeakers(
  threshold = 0.75,
  scope?: import('../domain/characterReview').SpeakerScope,
) {
  return invoke<string>('identify_speakers', { threshold, scope });
}
export interface PortraitOptions {
  characterId: string;
  lineId: string;
  atMs?: number;
  crop?: { x: number; y: number; width: number; height: number };
}
export interface ReferenceSegment {
  characterId: string;
  referenceId: string;
  startMs: number;
  endMs: number;
}
export interface LocalSeparationOptions {
  sourceTrackId: string;
  startMs: number;
  endMs: number;
  device: string;
}
export interface LocalSeparationProposal {
  id: string;
  options: LocalSeparationOptions;
  stale: boolean;
  applied: boolean;
  roles: string[];
}
export function separateAudioRegion(options: LocalSeparationOptions) {
  return invoke<string>('separate_audio_region', { options });
}
export function localSeparationResult(id: string) {
  return invoke<LocalSeparationProposal>('local_separation_result', { id });
}
export async function localSeparationUrl(id: string, role: string) {
  return convertFileSrc(await invoke<string>('local_separation_path', { id, role }));
}
export function applyLocalSeparation(id: string) {
  return invoke<Project>('apply_local_separation', { id });
}
export function captureCharacterPortrait(options: PortraitOptions) {
  return invoke<Project>('capture_character_portrait', { options });
}
export function prepareCharacterReference(segments: ReferenceSegment[], label: string) {
  return invoke<import('../domain/types').VoiceReference>('prepare_character_reference', {
    segments,
    label,
  });
}
export async function characterAssetUrl(path: string) {
  return convertFileSrc(await invoke<string>('character_asset_path', { path }));
}
export async function characterSampleUrl(lineId: string, trackId?: string) {
  return convertFileSrc(await invoke<string>('preview_character_sample', { lineId, trackId }));
}
export async function importVoiceReference(
  characterId: string,
  lineId: string | null,
  label: string,
): Promise<Project | null> {
  if (!native) throw new Error('DESKTOP_REQUIRED');
  const path = lineId
    ? null
    : await open({
        multiple: false,
        filters: [{ name: 'Audio', extensions: ['wav', 'flac', 'mp3', 'ogg', 'm4a'] }],
      });
  if (!lineId && !path) return null;
  return invoke<Project>('import_voice_reference', { characterId, lineId, path, label });
}
export async function importDubbingReference(
  lineId: string | null,
  options: import('../domain/types').VoiceSettings,
  selection?: ReferenceFileSelection,
): Promise<Project | null> {
  if (!native) throw new Error('DESKTOP_REQUIRED');
  const path =
    selection?.path ??
    (await open({
      multiple: false,
      filters: [{ name: 'Audio', extensions: ['wav', 'flac', 'mp3', 'ogg', 'm4a', 'aac', 'opus'] }],
    }));
  if (!path) return null;
  return invoke<Project>('import_dubbing_reference', {
    lineId,
    path,
    options,
    range: selection ? { startMs: selection.startMs, endMs: selection.endMs } : null,
  });
}
export type ReferenceAudioInfo = { path: string; durationMs: number; url: string };
export type DubbingBatchSelection = {
  scope: 'all' | 'selected';
  approvedOnly?: boolean;
  unapprovedOnly?: boolean;
  lineIds: string[];
  force: boolean;
  options: import('../domain/types').VoiceSettings;
};
export type DubbingBatchPreview = {
  requested: number;
  untranslated: number;
  unapproved: number;
  approved: number;
  existing: number;
  ready: string[];
  blocked: { lineId: string; error: string }[];
};
export function previewDubbingBatch(selection: DubbingBatchSelection) {
  return invoke<DubbingBatchPreview>('preview_dubbing_batch', { selection });
}
export function generateDubbingBatch(selection: DubbingBatchSelection) {
  return invoke<string>('generate_dubbing_batch', { selection });
}
export type ReferenceFileSelection = ReferenceAudioInfo & { startMs: number; endMs: number };
export async function chooseReferenceAudio(): Promise<ReferenceAudioInfo | null> {
  if (!native) throw Error('DESKTOP_REQUIRED');
  const path = await open({
    multiple: false,
    filters: [{ name: 'Audio', extensions: ['wav', 'flac', 'mp3', 'ogg', 'm4a', 'aac', 'opus'] }],
  });
  if (!path || typeof path !== 'string') return null;
  const info = await invoke<{ path: string; durationMs: number }>('reference_audio_info', { path });
  return { ...info, url: convertFileSrc(info.path) };
}
export function importCharacterReferenceFile(
  characterId: string,
  label: string,
  file: ReferenceFileSelection,
) {
  return invoke<Project>('import_voice_reference', {
    characterId,
    label,
    path: file.path,
    lineId: null,
    range: { startMs: file.startMs, endMs: file.endMs },
  });
}
export async function voiceReferenceUrl(
  characterId: string | null,
  referenceId: string,
): Promise<string> {
  return convertFileSrc(await invoke<string>('voice_reference_path', { characterId, referenceId }));
}
export function transcribeVoiceReference(
  characterId: string | null,
  referenceId: string,
  language = 'auto',
) {
  return invoke<string>('transcribe_voice_reference', { characterId, referenceId, language });
}
export async function graphicsInfo() {
  const data = await invoke<{
    preference: string;
    executable: string;
    adapters: { Name: string }[] | { Name: string };
  }>('graphics_info');
  return {
    ...data,
    adapters: Array.isArray(data.adapters) ? data.adapters : data.adapters ? [data.adapters] : [],
  };
}
export async function setGraphicsPreference(choice: string) {
  await invoke('set_graphics_preference', { choice });
}
export async function openGraphicsSettings() {
  await invoke('open_graphics_settings');
}
export async function separationStatus() {
  return invoke<{
    installed: boolean;
    installing: boolean;
    devices: { id: string; name: string }[];
    unavailableDevices?: { id: string; name: string; reason: string }[];
    cudaVersion?: string | null;
    deviceProbeWarning?: string | null;
  }>('separation_status');
}
export async function installSeparationRuntime(cuda: boolean) {
  return invoke<string>('install_separation_runtime', { cuda });
}
export async function separateAudio(device: string) {
  return invoke<string>('separate_audio', { device });
}
export async function pauseJob(id: string, paused: boolean) {
  await invoke('pause_job', { id, paused });
}
export async function audioUrls(project: Project) {
  if (!native || !project.tracks.some((track) => track.kind === 'audio'))
    return {} as Record<string, string>;
  const paths = await invoke<Record<string, string>>('audio_paths');
  return Object.fromEntries(Object.entries(paths).map(([id, path]) => [id, convertFileSrc(path)]));
}
export async function exportAudioTrack(project: Project, id: string, edited = false) {
  const track = project.tracks.find((track) => track.id === id);
  if (!track || !native) return false;
  const path = await save({
    defaultPath: `${track.role ?? 'audio'}${edited ? '-montage' : ''}.wav`,
    filters: [{ name: 'WAV', extensions: ['wav'] }],
  });
  if (path) {
    await invoke('export_audio_track', { id, path, edited });
    return true;
  }
  return false;
}
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
    tracks: browserProject.tracks.map((track) =>
      track.kind === 'original'
        ? { ...track, regions: undefined, regionsEnabled: undefined }
        : track,
    ),
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
export async function prepareProxy(lightweight = true): Promise<void> {
  if (native) await invoke('prepare_proxy', { lightweight });
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
export async function waveform(project: Project, track?: Track): Promise<Waveform | null> {
  if (native) return invoke('get_waveform', { trackId: track?.id ?? null });
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

export interface TranslationStatus {
  installed: boolean;
  modelName: string;
  sizeBytes: number;
  path: string;
  availableBytes: number | null;
  requiredBytes: number;
  enough: boolean;
  devices: { id: string; name: string }[];
  warning: string | null;
}
export function translationStatus() {
  return invoke<TranslationStatus>('translation_status');
}
export function installTranslationModel() {
  return invoke<string>('install_translation_model');
}
export function suggestTranslation(lineId: string, device: string, direction = '') {
  return invoke<string>('suggest_translation', { lineId, device, direction });
}
export function translationResult(id: string) {
  return invoke<import('../domain/translationProposal').TranslationProposal | null>(
    'translation_result',
    { id },
  );
}
export function latestTranslation(lineId: string) {
  return invoke<string | null>('latest_translation', { lineId });
}
